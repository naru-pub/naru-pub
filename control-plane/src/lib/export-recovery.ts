import { sql, type Kysely } from "kysely";
import type { DB } from "./db";

// Longer than the export processor's 30-minute hard timeout, including kill grace.
export async function recoverInterruptedExports(db: Kysely<DB>) {
  const result = await db
    .updateTable("home_directory_exports")
    .set({ status: "pending", started_at: null, error_message: null })
    .where("status", "=", "in_progress")
    .where((eb) =>
      eb.or([
        eb("started_at", "<", sql<Date>`now() - interval '35 minutes'`),
        eb.and([
          eb("started_at", "is", null),
          eb("created_at", "<", sql<Date>`now() - interval '35 minutes'`),
        ]),
      ]),
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
