/** @jest-environment node */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { Absurd } from "absurd-sdk";

jest.mock("@/lib/operator-alerts", () => ({
  operatorAlertsConfigured: () => true,
  sendOperatorAlert: jest.fn(async () => {}),
}));
const { sql } = require("kysely") as typeof import("kysely");
const { db, pool } =
  require("@/lib/database") as typeof import("@/lib/database");
const {
  MAINTENANCE_JOBS,
  maintenanceJob,
  enqueueTemplatePreview,
  pruneMaintenanceTasks,
} = require("../jobs") as typeof import("../jobs");
const { maintenanceCommand, maintenanceSchedule } =
  require("../schedules") as typeof import("../schedules");
const { executeMaintenance, runScript } =
  require("../worker") as typeof import("../worker");
const { registerJobs, noteJobResult, checkJobFailures } =
  require("@/lib/scheduled-jobs") as typeof import("@/lib/scheduled-jobs");
const alerts = require("@/lib/operator-alerts") as jest.Mocked<
  typeof import("@/lib/operator-alerts")
>;
const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

integration("durable maintenance", () => {
  beforeEach(async () => {
    await sql`truncate absurd.c_maintenance, absurd.e_maintenance, absurd.r_maintenance, absurd.t_maintenance, absurd.w_maintenance cascade`.execute(
      db,
    );
    await db.deleteFrom("cron_jobs").execute();
    await registerJobs(
      "worker",
      MAINTENANCE_JOBS.map((job) => ({
        name: job.name,
        everySeconds: job.minutes * 60,
      })),
    );
    alerts.sendOperatorAlert.mockReset();
    alerts.sendOperatorAlert.mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await db.destroy();
  });

  test("all schedule commands collapse repeated triggers and catch-up into one slot", async () => {
    await db.transaction().execute(async (trx) => {
      for (const job of MAINTENANCE_JOBS) {
        await sql.raw(maintenanceCommand(job)).execute(trx);
        await sql.raw(maintenanceCommand(job)).execute(trx);
      }
    });
    const tasks = await db
      .selectFrom("absurd.t_maintenance")
      .selectAll()
      .execute();
    expect(tasks).toHaveLength(16);
    expect(tasks.every((task) => task.max_attempts === 8)).toBe(true);
    expect(new Set(tasks.map((task) => task.idempotency_key)).size).toBe(16);
  });

  test("daily probes preserve scheduled UTC time and dedupe intervening hourly checks", async () => {
    const job = maintenanceJob("payment-refund-sync");
    expect(maintenanceSchedule(job)).toBe("15 * * * *");
    const command = maintenanceCommand(job);
    await db.transaction().execute(async (trx) => {
      for (const hour of [19, 20, 21, 22, 23])
        await sql
          .raw(
            command.replaceAll(
              "now()",
              `'2026-10-04 ${hour}:15:00+00'::timestamptz`,
            ),
          )
          .execute(trx);
      // A missed 19:15 trigger is caught by 20:15 on the next day.
      await sql
        .raw(
          command.replaceAll("now()", "'2026-10-05 20:15:00+00'::timestamptz"),
        )
        .execute(trx);
    });
    expect(
      await db.selectFrom("absurd.t_maintenance").select("task_id").execute(),
    ).toHaveLength(2);
  });

  test("daily catch-up before its clock time belongs to yesterday's slot", async () => {
    const job = maintenanceJob("payment-refund-sync"); // 19:15 UTC
    const command = maintenanceCommand(job);
    await sql
      .raw(command.replaceAll("now()", "'2026-10-04 19:14:00+00'::timestamptz"))
      .execute(db);
    await sql
      .raw(command.replaceAll("now()", "'2026-10-03 19:15:00+00'::timestamptz"))
      .execute(db);
    expect(
      await db.selectFrom("absurd.t_maintenance").selectAll().execute(),
    ).toHaveLength(1);
    await sql
      .raw(command.replaceAll("now()", "'2026-10-04 19:15:00+00'::timestamptz"))
      .execute(db);
    expect(
      await db.selectFrom("absurd.t_maintenance").selectAll().execute(),
    ).toHaveLength(2);
  });

  test("template intent commits with publication and rolls back on failure", async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        await enqueueTemplatePreview(trx, "rolled-back-version");
        throw new Error("publication rolled back");
      }),
    ).rejects.toThrow("publication rolled back");
    expect(
      await db.selectFrom("absurd.t_maintenance").selectAll().execute(),
    ).toHaveLength(0);
    await db.transaction().execute(async (trx) => {
      await enqueueTemplatePreview(trx, "version-one");
      await enqueueTemplatePreview(trx, "version-one");
      await enqueueTemplatePreview(trx, "version-two");
    });
    expect(
      await db.selectFrom("absurd.t_maintenance").selectAll().execute(),
    ).toHaveLength(2);
  });

  test("different slots and template previews cannot overlap the screenshot sweep", async () => {
    let started!: () => void;
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = jest.fn(async () => {
      started();
      await wait;
      return { code: 0, timedOut: false, outputTail: "ok" };
    });
    const signal = new AbortController().signal;
    const first = executeMaintenance(
      maintenanceJob("screenshot-updater"),
      signal,
      async () => {},
      run,
    );
    await running;
    try {
      expect(
        await executeMaintenance(
          maintenanceJob("screenshot-updater"),
          signal,
          async () => {},
          run,
        ),
      ).toBe(false);
      expect(
        await executeMaintenance(
          maintenanceJob("template-preview"),
          signal,
          async () => {},
          run,
        ),
      ).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await first;
    }
    expect(
      await executeMaintenance(
        maintenanceJob("template-preview"),
        signal,
        async () => {},
        run,
      ),
    ).toBe(true);
  });

  test("script failure records output, retries without leaking its lock, and alerts once until recovery", async () => {
    const job = maintenanceJob("payment-reconciliation");
    await expect(
      executeMaintenance(
        job,
        new AbortController().signal,
        async () => {},
        async () => ({ code: 1, timedOut: false, outputTail: "broken" }),
      ),
    ).rejects.toThrow("broken");
    const row = await db
      .selectFrom("payment_cron_runs")
      .selectAll()
      .where("script", "=", job.script)
      .orderBy("started_at", "desc")
      .executeTakeFirstOrThrow();
    expect(row.exit_code).toBe(1);
    await checkJobFailures();
    await checkJobFailures();
    expect(alerts.sendOperatorAlert).toHaveBeenCalledTimes(1);
    expect(
      await executeMaintenance(
        job,
        new AbortController().signal,
        async () => {},
        async () => ({ code: 0, timedOut: false, outputTail: "" }),
      ),
    ).toBe(true);
    await checkJobFailures();
    expect(alerts.sendOperatorAlert).toHaveBeenCalledTimes(2);
    expect(alerts.sendOperatorAlert.mock.calls[1][0].title).toContain("복구");
  });

  test("failed alert delivery retains state for the next worker heartbeat", async () => {
    await noteJobResult("media-cleanup", new Error("failed"));
    alerts.sendOperatorAlert.mockRejectedValueOnce(new Error("offline"));
    await expect(checkJobFailures()).rejects.toThrow("offline");
    await checkJobFailures();
    expect(alerts.sendOperatorAlert).toHaveBeenCalledTimes(2);
  });

  test("Absurd terminal failure reports even when no application handler completed", async () => {
    const workflows = new Absurd({ db: pool, queueName: "maintenance" });
    workflows.registerTask({ name: "fails" }, async () => {
      throw new Error("lease or task failure");
    });
    await workflows.spawn(
      "fails",
      { name: "media-cleanup" },
      { maxAttempts: 1 },
    );
    await workflows.workBatch("test", 120, 1);
    await checkJobFailures();
    expect(alerts.sendOperatorAlert.mock.calls[0][0].title).toContain(
      "media-cleanup",
    );
  });

  test("terminal preview failures use the screenshot monitoring row", async () => {
    const workflows = new Absurd({ db: pool, queueName: "maintenance" });
    workflows.registerTask({ name: "fails-preview" }, async () => {
      throw new Error("preview failed");
    });
    await workflows.spawn(
      "fails-preview",
      { name: "template-preview" },
      { maxAttempts: 1 },
    );
    await workflows.workBatch("test", 120, 1);
    await checkJobFailures();
    expect(alerts.sendOperatorAlert.mock.calls[0][0].title).toContain(
      "screenshot-updater",
    );
  });

  test("retention deletes old terminal maintenance work and preserves pending work and payment intents", async () => {
    const workflows = new Absurd({ db: pool, queueName: "maintenance" });
    workflows.registerTask({ name: "complete" }, async () => {});
    await workflows.spawn("complete", { name: "media-cleanup" });
    await workflows.workBatch("test", 120, 1);
    await db
      .updateTable("absurd.r_maintenance")
      .set({ completed_at: sql<Date>`now() - interval '31 days'` })
      .where("state", "=", "completed")
      .execute();
    const pending = await workflows.spawn("complete", {
      name: "media-cleanup",
    });
    await db
      .updateTable("absurd.t_maintenance")
      .set({ enqueue_at: sql<Date>`now() - interval '31 days'` })
      .where("task_id", "=", pending.taskID)
      .execute();
    const paymentsBefore = await db
      .selectFrom("absurd.t_payments")
      .select("task_id")
      .execute();
    expect(await pruneMaintenanceTasks(db)).toBe(1);
    expect(
      await db.selectFrom("absurd.t_maintenance").select("task_id").execute(),
    ).toEqual([{ task_id: pending.taskID }]);
    expect(
      await db.selectFrom("absurd.t_payments").select("task_id").execute(),
    ).toEqual(paymentsBefore);
  });

  test("a real timed-out child is killed before the adapter returns", async () => {
    const result = await runScript(
      {
        name: "export-processor",
        script: "../../tests/fixtures/maintenance-probe.ts",
        minutes: 2,
        timeout: 1,
      },
      new AbortController().signal,
    );
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    const pid = Number(
      result.outputTail.match(/maintenance-probe-pid:(\d+)/)?.[1],
    );
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15000);

  test("shutdown stops the adapter before releasing its overlap lock", async () => {
    const abort = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const task = executeMaintenance(
      maintenanceJob("export-processor"),
      abort.signal,
      async () => {},
      async (_job, signal) => {
        started();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
        return { code: 0, timedOut: false, outputTail: "" };
      },
    );
    await running;
    abort.abort(new Error("shutdown"));
    await expect(task).rejects.toThrow("shutdown");
    expect(
      await executeMaintenance(
        maintenanceJob("export-processor"),
        new AbortController().signal,
        async () => {},
        async () => ({ code: 0, timedOut: false, outputTail: "" }),
      ),
    ).toBe(true);
  });
});
