import { sql, type Kysely } from "kysely";
import type { DB } from "@/lib/db";

// Preserve a full 35 UTC days: detailed dashboards need a rolling 30 days.
// Bound each transaction and each run; another scheduled run resumes the backlog.
export async function prunePageviews(db: Kysely<DB>): Promise<number> {
  let removed = 0;
  for (const table of ["pageviews", "pageview_daily_visitors"] as const) {
    for (let batch = 0; batch < 100; batch++) {
      const count = await db.transaction().execute(async (trx) => {
        await sql`set local statement_timeout = '5s'`.execute(trx);
        const cutoff = sql`((now() at time zone 'UTC')::date - 35)`;
        const condition =
          table === "pageviews"
            ? sql`timestamp < (${cutoff}::timestamp at time zone 'UTC')`
            : sql`date < ${cutoff}`;
        const result = await sql`
          delete from ${sql.table(table)} where id in (
            select id from ${sql.table(table)} where ${condition}
            order by ${sql.ref(table === "pageviews" ? "timestamp" : "date")}, id
            limit 1000 for update skip locked
          )
        `.execute(trx);
        return Number(result.numAffectedRows ?? 0);
      });
      removed += count;
      if (count < 1000) break;
    }
  }
  return removed;
}
