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
  test("prunes expired raw data in batches and preserves lifetime counters and the cutoff day", async () => {
    const user = await db
      .insertInto("users")
      .values({ login_name: "pageview-retention-test", password_hash: "x" })
      .returning("id")
      .executeTakeFirstOrThrow();
    try {
      await sql`insert into pageviews (user_id, timestamp, path, ip)
        select ${user.id}, ((now() at time zone 'UTC')::date - 36)::timestamp at time zone 'UTC', '/', '192.0.2.1'::inet
        from generate_series(1, 1001)`.execute(db);
      await sql`insert into pageviews (user_id, timestamp, path, ip) values
        (${user.id}, ((now() at time zone 'UTC')::date - 35)::timestamp at time zone 'UTC', '/', '192.0.2.1'::inet),
        (${user.id}, now(), '/', '192.0.2.1'::inet)`.execute(db);
      await sql`insert into pageview_daily_visitors (user_id, date, ip) values
        (${user.id}, (now() at time zone 'UTC')::date - 36, '192.0.2.1'::inet),
        (${user.id}, (now() at time zone 'UTC')::date - 35, '192.0.2.1'::inet)`.execute(
        db,
      );
      await sql`insert into pageview_daily_stats (user_id, date, views, unique_visitors)
        values (${user.id}, (now() at time zone 'UTC')::date - 36, 1001, 1),
        (${user.id}, (now() at time zone 'UTC')::date, 2, 1)`.execute(db);
      expect(await prunePageviews(db)).toBeGreaterThanOrEqual(1002);
      const raw = await db
        .selectFrom("pageviews")
        .select(sql<number>`count(*)::int`.as("count"))
        .where("user_id", "=", user.id)
        .executeTakeFirstOrThrow();
      const visitors = await db
        .selectFrom("pageview_daily_visitors")
        .select(sql<number>`count(*)::int`.as("count"))
        .where("user_id", "=", user.id)
        .executeTakeFirstOrThrow();
      const totals = await db
        .selectFrom("pageview_daily_stats")
        .select(sql<number>`sum(views)::int`.as("views"))
        .where("user_id", "=", user.id)
        .executeTakeFirstOrThrow();
      expect(raw.count).toBe(2);
      expect(visitors.count).toBe(1);
      // Same SUM(views) used by 지금까지의 조회 on home/open/analytics.
      expect(totals.views).toBe(1003);
      expect(await prunePageviews(db)).toBe(0);
    } finally {
      await db.deleteFrom("users").where("id", "=", user.id).execute();
    }
  });
});
