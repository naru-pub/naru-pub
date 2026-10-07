import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";

jest.mock("@/lib/operator-alerts", () => ({
  operatorAlertsConfigured: () => true,
  sendOperatorAlert: jest.fn(async () => {}),
}));

// Required after the mocks: this transform does not hoist jest.mock above
// imports.
const { sql } = require("kysely") as typeof import("kysely");
const { db } = require("@/lib/database") as typeof import("@/lib/database");
const alerts = require("@/lib/operator-alerts") as jest.Mocked<
  typeof import("@/lib/operator-alerts")
>;
const { checkStalledJobs, noteJobStarted, registerJobs } =
  require("@/lib/scheduled-jobs") as typeof import("@/lib/scheduled-jobs");

// Runs against the disposable database of scripts/test-payments-db.sh.
const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

integration("scheduled jobs", () => {
  async function startedAgo(name: string, seconds: number) {
    await db
      .updateTable("cron_jobs")
      .set({
        last_started_at: sql<Date>`now() - make_interval(secs => ${seconds})`,
      })
      .where("name", "=", name)
      .execute();
  }

  async function withActiveRun(
    check: (runId: string, unlock: () => Promise<void>) => Promise<void>,
    taskName = "export-processor",
    monitoredName = "export-processor",
  ) {
    const { MAINTENANCE_LOCK_SPACE, MAINTENANCE_TASK } =
      require("@/lib/maintenance/jobs") as typeof import("@/lib/maintenance/jobs");
    await sql`select * from absurd.spawn_task('maintenance', ${MAINTENANCE_TASK},
      ${JSON.stringify({ name: taskName })}::jsonb, '{}'::jsonb)`.execute(db);
    const {
      rows: [run],
    } = await sql<{ run_id: string }>`
      select * from absurd.claim_task('maintenance', 'monitor-test', 120, 1)
    `.execute(db);
    await db.connection().execute(async (connection) => {
      await sql`select pg_advisory_lock(${MAINTENANCE_LOCK_SPACE}, hashtext(${monitoredName}))`.execute(
        connection,
      );
      const unlock = async () => {
        await sql`select pg_advisory_unlock(${MAINTENANCE_LOCK_SPACE}, hashtext(${monitoredName}))`.execute(
          connection,
        );
      };
      try {
        await check(run.run_id, unlock);
      } finally {
        await unlock();
      }
    });
  }

  beforeEach(async () => {
    await sql`truncate absurd.c_maintenance, absurd.e_maintenance, absurd.r_maintenance,
      absurd.t_maintenance, absurd.w_maintenance cascade`.execute(db);
    await db.deleteFrom("cron_jobs").execute();
    alerts.sendOperatorAlert.mockReset();
    alerts.sendOperatorAlert.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await db.destroy();
  });

  test("a job past its interval and grace is reported once, and its return", async () => {
    await registerJobs("cron", [
      { name: "every-minute", everySeconds: 60 },
      { name: "daily", everySeconds: 86400 },
    ]);
    // A minute job gets five minutes' grace; a daily one a tenth of a day.
    await startedAgo("every-minute", 60 + 5 * 60 + 10);
    await startedAgo("daily", 86400 + 60 * 60);

    expect(await checkStalledJobs()).toEqual({
      stalled: ["every-minute"],
      recovered: [],
    });
    expect(alerts.sendOperatorAlert).toHaveBeenCalledTimes(1);
    expect(alerts.sendOperatorAlert.mock.calls[0][0].title).toBe(
      "예약 작업 멈춤: every-minute",
    );

    // Told once while it stays stalled.
    expect(await checkStalledJobs()).toEqual({ stalled: [], recovered: [] });

    await noteJobStarted("every-minute");
    expect(await checkStalledJobs()).toEqual({
      stalled: [],
      recovered: ["every-minute"],
    });
    expect(alerts.sendOperatorAlert).toHaveBeenLastCalledWith({
      title: "예약 작업 재개: every-minute",
      lines: [],
    });
  });

  test("a healthy long export is not stalled, and an existing false alert recovers", async () => {
    await registerJobs("worker", [
      { name: "export-processor", everySeconds: 120 },
    ]);
    await startedAgo("export-processor", 10 * 60);
    await withActiveRun(async () => {
      expect(await checkStalledJobs()).toEqual({ stalled: [], recovered: [] });
      expect(alerts.sendOperatorAlert).not.toHaveBeenCalled();
      await db
        .updateTable("cron_jobs")
        .set({ stalled_at: new Date() })
        .where("name", "=", "export-processor")
        .execute();
      expect(await checkStalledJobs()).toEqual({
        stalled: [],
        recovered: ["export-processor"],
      });
      expect(alerts.sendOperatorAlert).toHaveBeenLastCalledWith({
        title: "예약 작업 재개: export-processor",
        lines: [],
      });
    });
  });

  test.each([
    "expired lease",
    "completed run",
    "sleeping run",
    "released lock",
    "hard timeout",
  ])("%s does not hide a stalled export schedule", async (reason) => {
    await registerJobs("worker", [
      { name: "export-processor", everySeconds: 120 },
    ]);
    await startedAgo("export-processor", 10 * 60);
    await withActiveRun(async (runId, unlock) => {
      if (reason === "expired lease")
        await db
          .updateTable("absurd.r_maintenance")
          .set({ claim_expires_at: new Date(Date.now() - 1000) })
          .where("run_id", "=", runId)
          .execute();
      if (reason === "completed run" || reason === "sleeping run")
        await db
          .updateTable("absurd.r_maintenance")
          .set({ state: reason === "completed run" ? "completed" : "sleeping" })
          .where("run_id", "=", runId)
          .execute();
      if (reason === "released lock") await unlock();
      if (reason === "hard timeout")
        await startedAgo("export-processor", 1800 + 10);
      expect(await checkStalledJobs()).toEqual({
        stalled: ["export-processor"],
        recovered: [],
      });
      expect(await checkStalledJobs()).toEqual({ stalled: [], recovered: [] });
    });
  });

  test("completion of a long export gives the next schedule its normal grace", async () => {
    await registerJobs("worker", [
      { name: "export-processor", everySeconds: 120 },
    ]);
    await startedAgo("export-processor", 20 * 60);
    await withActiveRun(async (runId, unlock) => {
      await db
        .updateTable("absurd.r_maintenance")
        .set({ state: "completed", completed_at: new Date() })
        .where("run_id", "=", runId)
        .execute();
      await db
        .updateTable("absurd.t_maintenance")
        .set({ state: "completed" })
        .where("last_attempt_run", "=", runId)
        .execute();
      await unlock();
      expect(await checkStalledJobs()).toEqual({ stalled: [], recovered: [] });
      await db
        .updateTable("absurd.r_maintenance")
        .set({ completed_at: new Date(Date.now() - 8 * 60 * 1000) })
        .where("run_id", "=", runId)
        .execute();
      expect(await checkStalledJobs()).toEqual({
        stalled: ["export-processor"],
        recovered: [],
      });
    });
  });

  test("template previews share screenshot monitoring but cannot suppress another job", async () => {
    await registerJobs("worker", [
      { name: "screenshot-updater", everySeconds: 60 },
      { name: "export-processor", everySeconds: 120 },
    ]);
    await startedAgo("screenshot-updater", 8 * 60);
    await startedAgo("export-processor", 10 * 60);
    await withActiveRun(
      async () => {
        expect(await checkStalledJobs()).toEqual({
          stalled: ["export-processor"],
          recovered: [],
        });
      },
      "template-preview",
      "screenshot-updater",
    );
  });

  test("an alert that cannot be posted is tried again", async () => {
    await registerJobs("worker", [{ name: "worker", everySeconds: 60 }]);
    await startedAgo("worker", 60 * 60);
    alerts.sendOperatorAlert.mockRejectedValueOnce(new Error("discord down"));

    await expect(checkStalledJobs()).rejects.toThrow("discord down");
    expect(await checkStalledJobs()).toEqual({
      stalled: ["worker"],
      recovered: [],
    });
  });

  test("a job no longer scheduled is forgotten, and the other process's kept", async () => {
    await registerJobs("worker", [{ name: "worker", everySeconds: 60 }]);
    await registerJobs("cron", [{ name: "old-job", everySeconds: 60 }]);
    await registerJobs("cron", [{ name: "new-job", everySeconds: 3600 }]);

    const rows = await db
      .selectFrom("cron_jobs")
      .select(["name", "process"])
      .orderBy("name")
      .execute();
    expect(rows).toEqual([
      { name: "new-job", process: "cron" },
      { name: "worker", process: "worker" },
    ]);
  });
});
