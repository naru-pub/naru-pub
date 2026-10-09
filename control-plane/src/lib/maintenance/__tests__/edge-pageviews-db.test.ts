/** @jest-environment node */
import { afterAll, describe, expect, jest, test } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import type { LoggedPageview } from "@/lib/analytics/edge-pageviews";

// The edge's pageview log, held in memory: drain hands out the oldest events,
// ack forgets them, and `loseAcks` makes acknowledgements vanish on the way.
let log: LoggedPageview[] = [];
let loseAcks = false;
jest.mock("@/lib/edge/client", () => ({
  callPageviewLog: async (operation: string, input: any) => {
    if (operation === "drain") return log.slice(0, input.limit);
    if (!loseAcks) log = log.filter((event) => event.id > input.through);
    return null;
  },
}));
const { drainEdgePageviews } =
  require("@/lib/analytics/edge-pageviews") as typeof import("@/lib/analytics/edge-pageviews");

const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

integration("edge pageview drain", () => {
  afterAll(async () => {
    await db.destroy();
  });

  test("stores each pageview once, as the proxy does, even when an acknowledgement is lost", async () => {
    const user = await db
      .insertInto("users")
      .values({ login_name: "edge-pageview-test", password_hash: "x" })
      .returning("id")
      .executeTakeFirstOrThrow();
    try {
      const at = Date.parse("2026-10-09T23:58:00Z");
      const before: number = Number(
        (
          await db
            .selectFrom("edge_pageview_cursors")
            .select("last_event_id")
            .executeTakeFirst()
        )?.last_event_id ?? 0,
      );
      const event = (id: number, ip: string, login = "edge-pageview-test") => ({
        id: before + id,
        login,
        timestamp: at + id * 60_000,
        path: "/",
        ip,
        referrer: null,
        userAgent: "test",
      });
      log = [
        event(1, "192.0.2.1"),
        event(2, "192.0.2.1"),
        event(3, "192.0.2.2"),
        event(4, "192.0.2.3", "nobody-by-this-name"),
        event(5, ""),
      ];
      // A run allowed no batches only reports how long events have waited.
      expect(await drainEdgePageviews(db, 0)).toEqual({
        stored: 0,
        skipped: 0,
        waitingSince: at + 60_000,
      });
      // The first run stores everything, but its acknowledgement is lost.
      loseAcks = true;
      expect(await drainEdgePageviews(db)).toEqual({
        stored: 3,
        skipped: 2,
        waitingSince: null,
      });
      expect(log).toHaveLength(5);
      // The next run is handed the same events and stores none twice.
      loseAcks = false;
      expect(await drainEdgePageviews(db)).toEqual({
        stored: 0,
        skipped: 5,
        waitingSince: null,
      });
      expect(log).toHaveLength(0);

      const days = await sql<{ date: string; views: number; unique: number }>`
        select to_char(date, 'YYYY-MM-DD') as date, views, unique_visitors as unique
        from pageview_daily_stats where user_id = ${user.id} order by date`.execute(
        db,
      );
      // The first visit is at 23:59 UTC on the 9th, the next two on the 10th,
      // where 192.0.2.1 is a new visitor again.
      expect(days.rows).toEqual([
        { date: "2026-10-09", views: 1, unique: 1 },
        { date: "2026-10-10", views: 2, unique: 2 },
      ]);
      const raw = await sql<{ count: number }>`
        select count(*)::int as count from pageviews where user_id = ${user.id}`.execute(
        db,
      );
      expect(raw.rows[0].count).toBe(3);
    } finally {
      await db.deleteFrom("users").where("id", "=", user.id).execute();
    }
  });
});
