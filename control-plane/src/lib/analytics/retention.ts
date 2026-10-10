import { sql, type Kysely } from "kysely";
import type { DB } from "@/lib/db";

// Preserve a full 35 UTC days: detailed dashboards need a rolling 30 days.
// Path, referrer and browser rollups go; daily site totals stay forever but
// lose their visitor sketch, which only multi-day unique counts read.
// Bound each transaction and each run; another scheduled run resumes the backlog.
export async function prunePageviews(db: Kysely<DB>): Promise<number> {
  let removed = 0;
  const cutoff = sql`((now() at time zone 'UTC')::date - 35)`;
  const tables = [
    "pageview_daily_paths",
    "pageview_daily_referrers",
    "pageview_daily_browsers",
  ] as const;
  const batches = [
    ...tables.map(
      (table) => sql`
        delete from ${sql.table(table)} where id in (
          select id from ${sql.table(table)} where date < ${cutoff}
          order by date, id
          limit 1000 for update skip locked
        )`,
    ),
    sql`
      update pageview_daily_stats set visitors = null
      where (user_id, date) in (
        select user_id, date from pageview_daily_stats
        where date < ${cutoff} and visitors is not null
        order by date, user_id
        limit 1000 for update skip locked
      )`,
  ];
  for (const statement of batches) {
    for (let batch = 0; batch < 100; batch++) {
      const count = await db.transaction().execute(async (trx) => {
        await sql`set local statement_timeout = '5s'`.execute(trx);
        const result = await statement.execute(trx);
        return Number(result.numAffectedRows ?? 0);
      });
      removed += count;
      if (count < 1000) break;
    }
  }
  return removed;
}
