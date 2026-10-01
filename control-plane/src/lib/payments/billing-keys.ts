import { sql } from "kysely";
import { db } from "@/lib/database";
import type { Executor } from "@/lib/entitlements";
import { notePaymentEvent } from "@/lib/payments/payment-events";
import { maskSecret } from "@/lib/payments/toss";
import { deleteKey } from "@/lib/payments/toss-gateway";

// Every billing key Toss issues is a billing_keys row (see the migration that
// adds it) and goes one way: active while a plan may charge it, retired once
// nothing will, deleted when Toss confirms it is gone — and only then does the
// row give up the key itself. A key stays chargeable at Toss for
// as long as its card is valid, years, so a key 나루 stops using must be
// deleted there too, and it can only be deleted while 나루 still has it.
//
// Every way a key leaves a plan — a cancel, a refund, a one-time switch, a new
// card, an account deletion — goes through retireBillingKey, in the caller's
// transaction; after that commits, the caller passes the returned id to
// deleteRetiredBillingKey, and the cron's deleteRetiredBillingKeys retries
// whatever Toss did not confirm. A test fails if anything else writes
// subscriptions.billing_key_id = null.

export type StoredKey = { id: string; status: string };

// Stores a key Toss just issued, as active. Toss hands back the same key for a
// retried authKey (its idempotency key replays the first answer for 15 days),
// so a key already stored is returned as it is, never stored twice.
export async function storeIssuedKey(
  trx: Executor,
  opts: {
    userId: string;
    customerKey: string;
    billingKey: string;
    cardCompany?: string | null;
    cardNumber?: string | null;
  },
): Promise<StoredKey> {
  const inserted = await trx
    .insertInto("billing_keys")
    .values({
      user_id: opts.userId,
      customer_key: opts.customerKey,
      billing_key: opts.billingKey,
      card_company: opts.cardCompany ?? null,
      card_number: opts.cardNumber ?? null,
    })
    .onConflict((oc) => oc.column("billing_key").doNothing())
    .returning(["id", "status"])
    .executeTakeFirst();
  if (inserted) return inserted;
  return trx
    .selectFrom("billing_keys")
    .select(["id", "status"])
    .where("billing_key", "=", opts.billingKey)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

// The key and customerKey a plan charges with, decrypted. Null when the plan
// holds no key.
export async function chargeableKey(
  executor: Executor,
  subscriptionId: string,
): Promise<{ billingKey: string; customerKey: string } | null> {
  const row = await executor
    .selectFrom("subscriptions")
    .innerJoin(
      "billing_keys",
      "billing_keys.id",
      "subscriptions.billing_key_id",
    )
    .select(["billing_keys.billing_key", "billing_keys.customer_key"])
    .where("subscriptions.id", "=", subscriptionId)
    .where("billing_keys.status", "=", "active")
    .executeTakeFirst();
  if (!row?.billing_key) return null;
  return {
    billingKey: row.billing_key,
    customerKey: row.customer_key,
  };
}

// Takes the plan's key away from it and retires it. Returns the key's id for
// deleteRetiredBillingKey, or null when the plan held none. With
// deletedAtToss (BILLING_DELETED), Toss already deleted it: nothing is left to
// do there, and the key itself goes now.
export async function retireBillingKey(
  trx: Executor,
  plan: { subscriptionId: string },
  opts: { deletedAtToss?: boolean } = {},
): Promise<string | null> {
  const row = await trx
    .selectFrom("subscriptions")
    .select(["id", "billing_key_id"])
    .where("id", "=", plan.subscriptionId)
    .forUpdate()
    .executeTakeFirst();
  const keyId = row?.billing_key_id ?? null;
  if (!row || !keyId) return null;
  await trx
    .updateTable("subscriptions")
    .set({ billing_key_id: null })
    .where("id", "=", row.id)
    .execute();
  return opts.deletedAtToss
    ? (await markDeletedAtToss(trx, keyId), null)
    : discardIssuedBillingKey(trx, keyId);
}

// Retires every key the account still has: its live plan's, and any issued
// key no plan took. For an account being deleted.
export async function retireUserBillingKeys(
  trx: Executor,
  userId: string,
): Promise<string[]> {
  const plans = await trx
    .selectFrom("subscriptions")
    .select("id")
    .where("user_id", "=", userId)
    .where("billing_key_id", "is not", null)
    .forUpdate()
    .execute();
  const retired: string[] = [];
  for (const plan of plans) {
    const id = await retireBillingKey(trx, { subscriptionId: plan.id });
    if (id) retired.push(id);
  }
  const loose = await trx
    .updateTable("billing_keys")
    .set({ status: "retired", retired_at: new Date() })
    .where("user_id", "=", userId)
    .where("status", "=", "active")
    .returning("id")
    .execute();
  return [...retired, ...loose.map((row) => row.id)];
}

// A key no plan holds or will hold — the signup it was issued for was
// canceled meanwhile, or its first charge failed — is retired the same way.
// Pass the result to deleteRetiredBillingKey after commit.
export async function discardIssuedBillingKey(
  trx: Executor,
  keyId: string,
): Promise<string> {
  await trx
    .updateTable("billing_keys")
    .set({ status: "retired", retired_at: new Date() })
    .where("id", "=", keyId)
    .where("status", "=", "active")
    .execute();
  return keyId;
}

export async function markDeletedAtToss(
  executor: Executor,
  keyId: string,
): Promise<void> {
  await executor
    .updateTable("billing_keys")
    .set({
      status: "deleted",
      billing_key: null,
      deleted_at: new Date(),
      retired_at: sql<Date>`coalesce(retired_at, now())`,
    })
    .where("id", "=", keyId)
    .execute();
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

// Deletes retired keys at Toss. The key itself is dropped as soon as Toss
// confirms; a failure stays retired and is retried later.
export async function deleteRetiredBillingKeys(now = new Date()) {
  const queued = await db
    .selectFrom("billing_keys")
    .select(["id", "billing_key", "delete_attempts"])
    .where("status", "=", "retired")
    .where((eb) =>
      eb.or([
        eb("delete_last_attempted_at", "is", null),
        eb(
          sql<Date>`delete_last_attempted_at + least(
            interval '${sql.raw(RETRY_AFTER)}' * power(2, least(greatest(delete_attempts - 1, 0), 5)),
            interval '${sql.raw(MAX_RETRY_AFTER)}'
          )`,
          "<=",
          now,
        ),
      ]),
    )
    .orderBy("retired_at", "asc")
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

type QueuedKey = {
  id: string;
  billing_key: string | null;
  delete_attempts: number;
};

async function deleteQueuedKey(row: QueuedKey, now: Date): Promise<boolean> {
  // The last look before a key is gone for good: a key some plan holds is its
  // card, whatever retired it. A bug that retires a live key must cost a
  // wrong status, never a supporter's card — so the key goes back to active,
  // and an operator is told.
  const holder = await db
    .selectFrom("subscriptions")
    .select(["id", "user_id"])
    .where("billing_key_id", "=", row.id)
    .executeTakeFirst();
  if (holder) {
    await db
      .updateTable("billing_keys")
      .set({ status: "active", retired_at: null })
      .where("id", "=", row.id)
      .execute();
    await notePaymentEvent({
      kind: "key_deletion_stuck",
      userId: holder.user_id,
      subscriptionId: holder.id,
      summary: `폐기된 빌링키 ${maskSecret(row.billing_key ?? "")}가 아직 정기 결제에 쓰이고 있어 지우지 않음 — 잘못 폐기된 키`,
    });
    console.error(
      `[delete-retired-billing-keys] key ${row.id}: still held by subscription ${holder.id}; not deleted`,
    );
    return false;
  }
  const deleted = row.billing_key
    ? await deleteKey(row.billing_key)
    : ({ kind: "deleted" } as const);
  if (deleted.kind === "failed") {
    const error = deleted.error;
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 2000);
    await db
      .updateTable("billing_keys")
      .set((eb) => ({
        delete_attempts: eb("delete_attempts", "+", 1),
        delete_last_attempted_at: now,
        delete_last_error: message,
      }))
      .where("id", "=", row.id)
      .execute();
    const attempts = row.delete_attempts + 1;
    if (attempts === STUCK_AFTER_ATTEMPTS) {
      await notePaymentEvent({
        kind: "key_deletion_stuck",
        summary: `빌링키 ${maskSecret(row.billing_key ?? "")} 삭제가 ${attempts}번 실패: ${message.slice(0, 300)}`,
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
  await markDeletedAtToss(db, row.id);
  return true;
}

// Deletes keys retireBillingKey just retired, once the caller's transaction
// has committed, so the key is gone in moments when Toss answers.
// Never throws: a key Toss did not confirm stays retired for the cron.
export async function deleteRetiredBillingKey(
  keyIds: string | null | Array<string | null>,
): Promise<void> {
  const ids = (Array.isArray(keyIds) ? keyIds : [keyIds]).filter(
    (id): id is string => id != null,
  );
  for (const id of ids) {
    try {
      const row = await db
        .selectFrom("billing_keys")
        .select(["id", "billing_key", "delete_attempts"])
        .where("id", "=", id)
        .where("status", "=", "retired")
        .executeTakeFirst();
      if (row) await deleteQueuedKey(row, new Date());
    } catch (error) {
      console.error("Retired billing key deletion error:", error);
    }
  }
}
