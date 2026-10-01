import { sql } from "kysely";
import { db } from "@/lib/database";
import { BoardError } from "./errors";

type Counted = "board_posts" | "board_replies" | "board_template_applications";

// Rolling-hour limits, counted from the rows themselves: every limited action
// leaves a row with the user and a created_at, so no separate counter table is
// needed.
export async function assertUnderHourlyLimit(
  table: Counted,
  userId: string,
  limit: number,
): Promise<void> {
  const row = await db
    .selectFrom(table)
    .select(sql<number>`count(*)::int`.as("count"))
    .where("user_id", "=", userId)
    .where("created_at", ">", sql<Date>`now() - interval '1 hour'`)
    .executeTakeFirstOrThrow();
  if (row.count >= limit) {
    throw new BoardError(429, "잠시 후에 다시 시도해 주세요.");
  }
}
