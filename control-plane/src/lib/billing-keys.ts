import { sql } from "kysely";
import { db } from "@/lib/database";
import type { Executor } from "@/lib/entitlements";
import { notePaymentEvent } from "@/lib/payment-events";
import { deleteBillingKey, maskSecret, TossApiError } from "@/lib/toss";

// Every way a billing key leaves subscriptions.toss_billing_key goes through
// retireBillingKey: a cancel, a refund, a one-time switch, a new card, an
// account deletion. Keys never expire at Toss and are stored here in plain
// text, so a key 나루 stops using must also be deleted there — and it can only
// be deleted while someone still has it. retireBillingKey moves it into
// retired_billing_keys in the caller's transaction; after that commits, the
// caller passes the returned key to deleteRetiredBillingKey, and the cron's
// deleteRetiredBillingKeys retries whatever Toss did not confirm.
//
// A test fails if anything else writes toss_billing_key = null.
export async function retireBillingKey(
  trx: Executor,
  subscription: { subscriptionId: string } | { userId: number },
  opts: { deletedAtToss?: boolean } = {},
): Promise<string | null> {
  const row = await trx
    .selectFrom("subscriptions")
    .select(["id", "toss_billing_key"])
    .where((eb) =>
      "subscriptionId" in subscription
        ? eb("id", "=", subscription.subscriptionId)
        : eb("user_id", "=", subscription.userId),
    )
    .forUpdate()
    .executeTakeFirst();
  const billingKey = row?.toss_billing_key ?? null;
  if (!row || !billingKey) return null;

  if (!opts.deletedAtToss) {
    await trx
      .insertInto("retired_billing_keys")
      .values({ billing_key: billingKey })
      .onConflict((oc) => oc.column("billing_key").doNothing())
      .execute();
  }
  await trx
    .updateTable("subscriptions")
    .set({ toss_billing_key: null })
    .where("id", "=", row.id)
    .execute();
  if (opts.deletedAtToss) {
    // Toss told us the key is gone (BILLING_DELETED), so nothing is left to
    // delete there — including a copy queued earlier.
    await trx
      .deleteFrom("retired_billing_keys")
      .where("billing_key", "=", billingKey)
      .execute();
  }
  return opts.deletedAtToss ? null : billingKey;
}

// A key Toss issued that never reached a subscription — the signup it was for
// was canceled while Toss was issuing it — is queued for deletion the same way
// a retired one is. Pass the result to deleteRetiredBillingKey after commit.
export async function discardIssuedBillingKey(
  trx: Executor,
  billingKey: string,
): Promise<string> {
  await trx
    .insertInto("retired_billing_keys")
    .values({ billing_key: billingKey })
    .onConflict((oc) => oc.column("billing_key").doNothing())
    .execute();
  return billingKey;
}

const BATCH_SIZE = 100;
// A key Toss would not delete is retried after an hour, then backs off by
// doubling up to once a day. The docs do not say how DELETE answers a key Toss
// no longer knows, so a refusal that is really "already gone" would otherwise
// be retried hourly forever; past STUCK_AFTER_ATTEMPTS it is logged as stuck
// so someone looks at the error it keeps getting. (The exponent is capped
// before the day cap applies: 2^n hours overflows an interval long before n
// reaches the attempt counts a stuck key piles up.)
const RETRY_AFTER = "1 hour";
const MAX_RETRY_AFTER = "1 day";
export const STUCK_AFTER_ATTEMPTS = 5;

// Toss answers a key it no longer has with a not-found error. That key is as
// deleted as it will ever be.
function alreadyGone(error: unknown): boolean {
  return (
    error instanceof TossApiError &&
    (error.status === 404 || (error.code ?? "").startsWith("NOT_FOUND"))
  );
}

// Deletes the billing keys queued in retired_billing_keys (see the migration
// that adds it) at Toss. The row, which holds the key in plain text, is removed
// as soon as Toss confirms; a failure stays queued and is retried later.
export async function deleteRetiredBillingKeys(now = new Date()) {
  const queued = await db
    .selectFrom("retired_billing_keys")
    .select(["id", "billing_key", "attempts"])
    .where((eb) =>
      eb.or([
        eb("last_attempted_at", "is", null),
        eb(
          sql<Date>`last_attempted_at + least(
            interval '${sql.raw(RETRY_AFTER)}' * power(2, least(greatest(attempts - 1, 0), 5)),
            interval '${sql.raw(MAX_RETRY_AFTER)}'
          )`,
          "<=",
          now,
        ),
      ]),
    )
    .orderBy("id", "asc")
    .limit(BATCH_SIZE)
    .execute();

  let deleted = 0;
  let failed = 0;
  for (const row of queued) {
    if (await deleteQueuedKey(row, now)) {
      deleted += 1;
    } else {
      failed += 1;
    }
  }
  return { deleted, failed };
}

async function deleteQueuedKey(
  row: { id: string; billing_key: string; attempts: number },
  now: Date,
): Promise<boolean> {
  try {
    await deleteBillingKey(row.billing_key);
  } catch (error) {
    if (!alreadyGone(error)) {
      await db
        .updateTable("retired_billing_keys")
        .set((eb) => ({
          attempts: eb("attempts", "+", 1),
          last_attempted_at: now,
          last_error: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 2000),
        }))
        .where("id", "=", row.id)
        .execute();
      const attempts = row.attempts + 1;
      if (attempts === STUCK_AFTER_ATTEMPTS) {
        await notePaymentEvent({
          kind: "key_deletion_stuck",
          summary: `빌링키 ${maskSecret(row.billing_key)} 삭제가 ${attempts}번 실패: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
        });
      }
      console.error(
        attempts >= STUCK_AFTER_ATTEMPTS
          ? `[delete-retired-billing-keys] key ${row.id}: STUCK, deletion failed ${attempts} times`
          : `[delete-retired-billing-keys] key ${row.id}: deletion failed`,
        error,
      );
      return false;
    }
  }
  await db
    .deleteFrom("retired_billing_keys")
    .where("id", "=", row.id)
    .execute();
  return true;
}

// Deletes a key retireBillingKey just queued, once the caller's transaction has
// committed, so the plain-text copy is gone in milliseconds when Toss answers.
// Never throws: a key Toss did not confirm stays queued for the cron.
export async function deleteRetiredBillingKey(
  billingKey: string | null,
): Promise<void> {
  if (!billingKey) return;
  try {
    const row = await db
      .selectFrom("retired_billing_keys")
      .select(["id", "billing_key", "attempts"])
      .where("billing_key", "=", billingKey)
      .executeTakeFirst();
    if (row) await deleteQueuedKey(row, new Date());
  } catch (error) {
    console.error("Retired billing key deletion error:", error);
  }
}
