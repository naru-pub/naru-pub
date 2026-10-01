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

  beforeEach(async () => {
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
