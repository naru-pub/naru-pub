import { withAccountLock } from "@/lib/payments/account-lock";
import {
  deleteRetiredBillingKey,
  retireUserBillingKeys,
} from "@/lib/payments/billing-keys";
import { sql } from "kysely";
import { db } from "@/lib/database";
import type { Executor } from "@/lib/entitlements";
import { endPlan, plansOf } from "@/lib/payments/subscriptions";
import {
  settleOneTimeOrders,
  settlePendingCharges,
} from "@/lib/payments/payment-reconciliation";

export const CHARGE_IN_FLIGHT_MESSAGE =
  "결제 또는 환불 결과를 확인하고 있어 지금은 계정을 삭제할 수 없습니다. 잠시 후 다시 시도해 주세요.";

// How long a deletion waits for another payment operation on the account
// (lib/payments/account-lock) before telling the supporter to try again.
export const DELETION_LOCK_WAIT_MS = 10_000;

// Run before anything of the account is deleted, under the account lock, so a
// refusal leaves the account whole. Settles the subscription's charges whose
// outcome is unknown and the one-time orders that may still be approved; then,
// when none is left unresolved, ends the plan — the supporter is deleting the
// account — so no renewal can start while the site's files are being deleted.
// False (and nothing changed) when the account must wait. Throws
// AccountBusyError when another payment operation holds the lock.
export async function settleChargesBeforeDeletion(
  userId: string,
): Promise<boolean> {
  return withAccountLock(
    userId,
    { waitMs: DELETION_LOCK_WAIT_MS },
    async () => {
      if (!(await settlePendingCharges(userId))) return false;
      // A one-time payment the buyer authenticated and Toss is still
      // approving would charge an account about to be gone.
      if (!(await settleOneTimeOrders(userId))) return false;

      // Recorded, so a deletion that fails after this (an S3 error) still
      // explains the canceled plan.
      const ended = await db.transaction().execute(async (trx) => {
        const subscription = await plansOf(trx, userId)
          .select("id")
          .executeTakeFirst();
        return subscription
          ? endPlan(trx, subscription.id, {
              summary: (from) =>
                `계정 삭제를 시작해 정기 결제를 취소 (${from}에서)`,
            })
          : null;
      });
      await deleteRetiredBillingKey(ended?.retiredKey ?? null);
      return true;
    },
  );
}

// Retain an anonymized account identity and its financial graph. The caller
// holds the account lock; account content and credentials disappear atomically.
// Lock payments, user, then subscriptions in the same order as payment facts.
export async function deleteUserRow(
  trx: Executor,
  userId: string,
): Promise<string[]> {
  await trx
    .selectFrom("payments")
    .select("id")
    .where("user_id", "=", userId)
    .forUpdate()
    .execute();
  await trx
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .forUpdate()
    .execute();
  await trx
    .selectFrom("subscriptions")
    .select("id")
    .where("user_id", "=", userId)
    .forUpdate()
    .execute();
  const retired = await retireUserBillingKeys(trx, userId);
  const plan = await plansOf(trx, userId).select("id").executeTakeFirst();
  if (plan)
    await endPlan(trx, plan.id, {
      summary: () => "계정 삭제로 정기 결제 취소",
    });
  await eraseAccountContent(trx, userId);
  await trx
    .updateTable("users")
    .set({ deleted_at: new Date() })
    .where("id", "=", userId)
    .execute();
  return retired;
}

// Reproduce users' content cascades while keeping the financial graph, whose
// foreign keys use RESTRICT. Discover relations from the schema so new content
// tables cannot silently survive account deletion. Identifiers come from the
// PostgreSQL catalog and are escaped by Kysely; the account ID is bound data.
async function eraseAccountContent(
  trx: Executor,
  userId: string,
): Promise<void> {
  const { rows } = await sql<{
    schema_name: string;
    table_name: string;
    column_name: string;
    action: "c" | "n";
  }>`
    select n.nspname as schema_name, t.relname as table_name,
      a.attname as column_name, c.confdeltype as action
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'users'::regclass
      and c.confdeltype in ('c', 'n')
    order by n.nspname, t.relname, a.attname
  `.execute(trx);
  for (const row of rows) {
    const table = sql.table(`${row.schema_name}.${row.table_name}`);
    const column = sql.ref(row.column_name);
    if (row.action === "c") {
      await sql`delete from ${table} where ${column} = ${userId}::uuid`.execute(
        trx,
      );
    } else {
      await sql`update ${table} set ${column} = null where ${column} = ${userId}::uuid`.execute(
        trx,
      );
    }
  }
}
