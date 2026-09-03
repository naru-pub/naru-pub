import { db } from "@/lib/database";
import type { Feature } from "@/lib/entitlements";

// A refund of an unused period hinges on one question — did this account
// actually get anything out of the 후원자 전용 기능 after paying? — so every
// place a supporter feature does real work records that it did. Reads of the
// ledger only ever compare "last used" against a payment date, so a single row
// per (user, feature) is enough; no event log is kept.
//
// Writes sit on request paths that can be hot (the site data API), so a use
// already recorded within this window is not written again. The window is short
// enough that a use right after a payment still lands on the payment's side of
// the comparison.
const RECORD_THROTTLE_MS = 5 * 60 * 1000;

export type SupporterFeatureUse = {
  feature: Feature;
  firstUsedAt: Date;
  lastUsedAt: Date;
};

async function record(userId: number, feature: Feature): Promise<void> {
  const now = new Date();
  const existing = await db
    .selectFrom("supporter_feature_uses")
    .select("last_used_at")
    .where("user_id", "=", userId)
    .where("feature", "=", feature)
    .executeTakeFirst();

  if (
    existing &&
    now.getTime() - new Date(existing.last_used_at).getTime() <
      RECORD_THROTTLE_MS
  ) {
    return;
  }

  await db
    .insertInto("supporter_feature_uses")
    .values({
      user_id: userId,
      feature,
      first_used_at: now,
      last_used_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "feature"]).doUpdateSet({ last_used_at: now }),
    )
    .execute();
}

// Fire-and-forget: the ledger is billing bookkeeping, so failing to write it
// must never fail the feature the user actually asked for.
export function noteSupporterFeatureUse(userId: number, feature: Feature) {
  void record(userId, feature).catch((error) => {
    console.error(
      `Failed to record supporter feature use (${feature}) for user ${userId}`,
      error,
    );
  });
}

export async function getSupporterFeatureUses(
  userId: number,
): Promise<SupporterFeatureUse[]> {
  const rows = await db
    .selectFrom("supporter_feature_uses")
    .select(["feature", "first_used_at", "last_used_at"])
    .where("user_id", "=", userId)
    .orderBy("last_used_at", "desc")
    .execute();
  return rows.map((row) => ({
    feature: row.feature as Feature,
    firstUsedAt: new Date(row.first_used_at),
    lastUsedAt: new Date(row.last_used_at),
  }));
}

export async function getLastSupporterFeatureUse(
  userId: number,
): Promise<Date | null> {
  const uses = await getSupporterFeatureUses(userId);
  return uses[0]?.lastUsedAt ?? null;
}

// The /admin listing shows usage next to every payment, so it reads the ledger
// for a whole page of payments at once instead of per row.
export async function getSupporterFeatureUsesForUsers(
  userIds: number[],
): Promise<Map<number, SupporterFeatureUse[]>> {
  const byUser = new Map<number, SupporterFeatureUse[]>();
  if (userIds.length === 0) return byUser;
  const rows = await db
    .selectFrom("supporter_feature_uses")
    .select(["user_id", "feature", "first_used_at", "last_used_at"])
    .where("user_id", "in", [...new Set(userIds)])
    .orderBy("last_used_at", "desc")
    .execute();
  for (const row of rows) {
    const uses = byUser.get(row.user_id) ?? [];
    uses.push({
      feature: row.feature as Feature,
      firstUsedAt: new Date(row.first_used_at),
      lastUsedAt: new Date(row.last_used_at),
    });
    byUser.set(row.user_id, uses);
  }
  return byUser;
}
