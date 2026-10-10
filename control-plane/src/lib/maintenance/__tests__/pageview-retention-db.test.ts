/** @jest-environment node */
import { afterAll, describe, expect, test } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { prunePageviews } from "@/lib/analytics/retention";

const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;
integration("pageview retention", () => {
  afterAll(async () => {
    await db.destroy();
  });
  test("prunes expired rollups and sketches in batches and preserves lifetime counters and the cutoff day", async () => {
    const user = await db
      .insertInto("users")
      .values({ login_name: "pageview-retention-test", password_hash: "x" })
      .returning("id")
      .executeTakeFirstOrThrow();
    try {
      const sketch = sql`hll_add_agg(hll_hash_text('192.0.2.1'), 14)`;
      const day = (ago: number) =>
        sql`(now() at time zone 'UTC')::date - ${sql.lit(ago)}`;
      // 1,001 expired paths: more than one batch.
      await sql`insert into pageview_daily_paths (user_id, date, path, views, visitors)
        select ${user.id}, ${day(36)}, '/' || i, 1, (select ${sketch})
        from generate_series(1, 1001) as i`.execute(db);
      await sql`insert into pageview_daily_paths (user_id, date, path, views, visitors)
        select ${user.id}, ${day(35)}, '/', 1, ${sketch}`.execute(db);
      await sql`insert into pageview_daily_referrers (user_id, date, referrer, views)
        values (${user.id}, ${day(36)}, '', 1), (${user.id}, ${day(35)}, '', 1)`.execute(
        db,
      );
      await sql`insert into pageview_daily_browsers (user_id, date, browser, views)
        values (${user.id}, ${day(36)}, 'Firefox', 1), (${user.id}, ${day(35)}, 'Firefox', 1)`.execute(
        db,
      );
      await sql`insert into pageview_daily_stats (user_id, date, views, unique_visitors, visitors)
        select ${user.id}::uuid, ${day(36)}, 1001, 1, ${sketch}
        union all select ${user.id}, ${day(35)}, 1, 1, ${sketch}
        union all select ${user.id}, ${day(0)}, 2, 1, ${sketch}`.execute(db);

      // 1,001 + 1 + 1 rows deleted and one sketch dropped.
      expect(await prunePageviews(db)).toBe(1004);
      const left = await sql<{
        paths: number;
        referrers: number;
        browsers: number;
      }>`
        select
          (select count(*)::int from pageview_daily_paths where user_id = ${user.id}) as paths,
          (select count(*)::int from pageview_daily_referrers where user_id = ${user.id}) as referrers,
          (select count(*)::int from pageview_daily_browsers where user_id = ${user.id}) as browsers`.execute(
        db,
      );
      expect(left.rows).toEqual([{ paths: 1, referrers: 1, browsers: 1 }]);
      const days = await sql<{ ago: number; views: number; sketch: boolean }>`
        select (now() at time zone 'UTC')::date - date as ago, views,
          visitors is not null as sketch
        from pageview_daily_stats where user_id = ${user.id} order by date`.execute(
        db,
      );
      // Same SUM(views) used by 지금까지의 조회 on home/open/analytics.
      expect(days.rows).toEqual([
        { ago: 36, views: 1001, sketch: false },
        { ago: 35, views: 1, sketch: true },
        { ago: 0, views: 2, sketch: true },
      ]);
      expect(await prunePageviews(db)).toBe(0);
    } finally {
      await db.deleteFrom("users").where("id", "=", user.id).execute();
    }
  });
});
