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

  test("counts each pageview once into the daily rollups, even when an acknowledgement is lost", async () => {
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
      // A later batch merges into the day's sketches: 192.0.2.2 is not new.
      log = [{ ...event(6, "192.0.2.2"), path: "/about" }];
      expect(await drainEdgePageviews(db)).toEqual({
        stored: 1,
        skipped: 0,
        waitingSince: null,
      });
      const today = await sql<{ views: number; unique: number }>`
        select views, unique_visitors as unique from pageview_daily_stats
        where user_id = ${user.id} and date = '2026-10-10'`.execute(db);
      expect(today.rows).toEqual([{ views: 3, unique: 2 }]);

      const paths = await sql<{ path: string; views: number; unique: number }>`
        select path, sum(views)::int as views,
          round(hll_cardinality(hll_union_agg(visitors)))::int as unique
        from pageview_daily_paths where user_id = ${user.id}
        group by path order by path`.execute(db);
      // / had 192.0.2.1 on both days and 192.0.2.2 on the 10th.
      expect(paths.rows).toEqual([
        { path: "/", views: 3, unique: 2 },
        { path: "/about", views: 1, unique: 1 },
      ]);
      const referrers = await sql<{ referrer: string; views: number }>`
        select referrer, sum(views)::int as views from pageview_daily_referrers
        where user_id = ${user.id} group by referrer`.execute(db);
      expect(referrers.rows).toEqual([{ referrer: "", views: 4 }]);
      const browsers = await sql<{ browser: string; views: number }>`
        select browser, sum(views)::int as views from pageview_daily_browsers
        where user_id = ${user.id} group by browser`.execute(db);
      expect(browsers.rows).toEqual([{ browser: "(기타)", views: 4 }]);
    } finally {
      await db.deleteFrom("users").where("id", "=", user.id).execute();
    }
  });
});
