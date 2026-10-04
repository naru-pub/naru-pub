import { sql } from "kysely";
import { db } from "@/lib/database";
import { withAccountLock } from "@/lib/payments/account-lock";
import { enqueueJob } from "@/lib/payments/payment-jobs";
import { recordPaymentEvent } from "@/lib/payments/payment-events";
import { planPaidTimeRepair, repairPaidTime } from "@/lib/payments/paid-time";

export class EntitlementRepairError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function requestEntitlementRepair(
  userId: string,
  operator: { id: string; loginName: string },
  reason: string,
) {
  reason = reason.trim();
  if (!reason || reason.length > 200)
    throw new EntitlementRepairError(
      "복구 사유를 200자 이내로 입력해 주세요.",
      400,
    );
  return db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom("users")
      .select(["deleted_at", "supporter_comp"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!user || user.deleted_at)
      throw new EntitlementRepairError(
        "삭제된 계정은 복구할 수 없습니다.",
        409,
      );
    if (user.supporter_comp)
      throw new EntitlementRepairError(
        "무료 이용 계정의 기한은 복구하지 않습니다.",
        409,
      );
    const created = await trx
      .insertInto("entitlement_repairs")
      .values({
        user_id: userId,
        operator_id: operator.id,
        operator_login_name: operator.loginName,
        reason,
      })
      .onConflict((oc) =>
        oc.column("user_id").where("completed_at", "is", null).doNothing(),
      )
      .returning("id")
      .executeTakeFirst();
    if (!created) {
      const pending = await trx
        .selectFrom("entitlement_repairs")
        .select("id")
        .where("user_id", "=", userId)
        .orderBy("id", "desc")
        .executeTakeFirstOrThrow();
      return { repairId: pending.id };
    }
    await enqueueJob(
      trx,
      { kind: "repair_entitlement", repairId: created.id, userId },
      { dedupeKey: `entitlement-repair:${created.id}` },
    );
    await recordPaymentEvent(trx, {
      kind: "entitlement_repair_requested",
      userId,
      summary: `운영자 ${operator.loginName} (${operator.id}) 이용 기한 복구 ${created.id} 요청: ${reason}`,
    });
    return { repairId: created.id };
  });
}

export async function runEntitlementRepair(repairId: string) {
  const request = await db
    .selectFrom("entitlement_repairs")
    .select("user_id")
    .where("id", "=", repairId)
    .executeTakeFirstOrThrow();
  await withAccountLock(request.user_id, { waitMs: 0 }, () =>
    db.transaction().execute(async (trx) => {
      const repair = await trx
        .selectFrom("entitlement_repairs")
        .selectAll()
        .where("id", "=", repairId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (repair.completed_at) return;
      await trx
        .selectFrom("payments")
        .select("id")
        .where("user_id", "=", repair.user_id)
        .orderBy("id")
        .forUpdate()
        .execute();
      const user = await trx
        .selectFrom("users")
        .select(["supporter_until", "supporter_comp", "deleted_at"])
        .where("id", "=", repair.user_id)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      await trx
        .selectFrom("subscriptions")
        .select("id")
        .where("user_id", "=", repair.user_id)
        .orderBy("id")
        .forUpdate()
        .execute();
      const skipped = user.deleted_at
        ? "계정 삭제"
        : user.supporter_comp
          ? "무료 이용 계정"
          : null;
      if (!skipped) {
        const inconsistent = await trx
          .selectFrom("payments as p")
          .select("p.id")
          .where("p.user_id", "=", repair.user_id)
          .where(
            sql<boolean>`p.refunded_amount <> (select coalesce(sum(t.amount), 0) from payment_transactions t where t.payment_id=p.id and t.kind='cancel')
            or (p.period_end is not null and not exists (select 1 from payment_transactions t where t.payment_id=p.id and t.kind='approval' and t.amount=p.amount))`,
          )
          .executeTakeFirst();
        if (inconsistent)
          throw new Error(
            `Resolve payment ledger mismatch ${inconsistent.id} before repairing entitlement`,
          );
      }
      const result = skipped
        ? {
            before: user.supporter_until,
            after: user.supporter_until,
            changedPaymentIds: [] as string[],
          }
        : await repairPaidTime(trx, repair.user_id);
      await trx
        .updateTable("entitlement_repairs")
        .set({
          status: skipped ? "skipped" : "completed",
          completed_at: new Date(),
          before_until: result.before,
          after_until: result.after,
          result_note: skipped,
          changed_payment_ids: result.changedPaymentIds,
        })
        .where("id", "=", repairId)
        .execute();
      const date = (value: Date | null) => value?.toISOString() ?? "없음";
      await recordPaymentEvent(trx, {
        kind: skipped ? "entitlement_repair_skipped" : "entitlement_repaired",
        userId: repair.user_id,
        summary: `이용 기한 복구 ${repairId}: ${date(result.before)} → ${date(result.after)}${skipped ? ` · 건너뜀 (${skipped})` : ""} · 운영자 ${repair.operator_login_name} (${repair.operator_id}): ${repair.reason}`,
      });
    }),
  );
}

export async function entitlementRepairCandidates(now = new Date()) {
  const records = await db
    .selectFrom("users as u")
    .leftJoin("payments as p", "p.user_id", "u.id")
    .select([
      "u.id as user_id",
      "u.login_name",
      "u.supporter_until",
      "p.id as payment_id",
      "p.order_id",
      "p.amount",
      "p.period_start",
      "p.period_end",
      "p.refunded_amount",
      "p.refunded_at",
      "p.paid_time_revoked_at",
    ])
    .where("u.deleted_at", "is", null)
    .where("u.supporter_comp", "=", false)
    .orderBy("u.id")
    .orderBy("p.id")
    .execute();
  const groups = new Map<string, typeof records>();
  for (const row of records) {
    const rows = groups.get(row.user_id) ?? [];
    rows.push(row);
    groups.set(row.user_id, rows);
  }
  return [...groups]
    .flatMap(([userId, rows]) => {
      const payments = rows.flatMap((row) =>
        row.payment_id
          ? [
              {
                id: row.payment_id,
                orderId: row.order_id!,
                amount: row.amount!,
                period_start: row.period_start,
                period_end: row.period_end,
                refunded_amount: row.refunded_amount!,
                refunded_at: row.refunded_at,
                paid_time_revoked_at: row.paid_time_revoked_at,
              },
            ]
          : [],
      );
      const plan = planPaidTimeRepair(payments);
      const beforeUntil = rows[0].supporter_until;
      const delta =
        Math.max(now.getTime(), beforeUntil?.getTime() ?? 0) -
        Math.max(now.getTime(), plan.expectedUntil?.getTime() ?? 0);
      if (Math.abs(delta) <= 60_000 && !plan.changedPaymentIds.length)
        return [];
      return [
        {
          userId,
          loginName: rows[0].login_name,
          beforeUntil,
          expectedUntil: plan.expectedUntil,
          payments: payments.map((payment, index) => ({
            ...payment,
            afterStart: plan.rows[index].period_start,
            afterEnd: plan.rows[index].period_end,
            needsRevocation:
              payment.refunded_amount > 0 && !payment.paid_time_revoked_at,
          })),
        },
      ];
    })
    .slice(0, 50);
}

export async function entitlementRepairHistory() {
  return db
    .selectFrom("entitlement_repairs as r")
    .innerJoin("users as u", "u.id", "r.user_id")
    .selectAll("r")
    .select("u.login_name")
    .orderBy("r.created_at", "desc")
    .limit(20)
    .execute();
}
