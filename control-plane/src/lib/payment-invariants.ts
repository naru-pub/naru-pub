import { sql } from "kysely";
import { AccountBusyError, withAccountLock } from "@/lib/account-lock";
import { deleteRetiredBillingKey } from "@/lib/billing-keys";
import { db } from "@/lib/database";
import { notePaymentEvent } from "@/lib/payment-events";
import { supporterUntilFromLedger } from "@/lib/paid-time";
import { retireUnusedSignupKey } from "@/lib/subscriptions";

const DAY_MS = 24 * 60 * 60 * 1000;

// A signup abandoned with its card registered — the supporter left after the
// key was stored, or the confirm process died before its first charge — keeps
// a chargeable key, and nothing else retires it until the
// supporter starts over. After a day with nothing pending it is retired; a
// later signup registers a card again anyway. Run by the key-deletion job.
export async function retireAbandonedSignupKeys(
  now = new Date(),
): Promise<number> {
  const abandoned = await db
    .selectFrom("subscriptions as s")
    .select(["s.id", "s.user_id"])
    .where("s.status", "=", "incomplete")
    .where("s.billing_key_id", "is not", null)
    .where("s.updated_at", "<", new Date(now.getTime() - DAY_MS))
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("payments as p")
            .select("p.id")
            .whereRef("p.subscription_id", "=", "s.id")
            .where("p.status", "=", "pending"),
        ),
      ),
    )
    .execute();

  let retired = 0;
  for (const subscription of abandoned) {
    try {
      const key = await withAccountLock(
        subscription.user_id,
        { waitMs: 0 },
        () =>
          db
            .transaction()
            .execute((trx) => retireUnusedSignupKey(trx, subscription.id)),
      );
      if (key) {
        retired += 1;
        await deleteRetiredBillingKey(key);
        console.log(
          `[payments] retired the card of signup ${subscription.id}, abandoned for over a day`,
        );
      }
    } catch (error) {
      if (!(error instanceof AccountBusyError)) throw error;
    }
  }
  return retired;
}

export type InvariantViolations = Record<string, string[]>;

// Rules the payment data must always satisfy, checked nightly. Each is
// enforced by the code that writes it; this is the net under that code, so a
// writer that gets one wrong surfaces as an operator event the next morning
// instead of in a review or a supporter's mail. Returns the violations found,
// by rule, with up to a few example ids each.
export async function checkPaymentInvariants(
  now = new Date(),
): Promise<InvariantViolations> {
  const found: InvariantViolations = {};
  const note = (rule: string, ids: string[]) => {
    if (ids.length > 0) found[rule] = ids;
  };

  // A plan's key against its status, a done payment's period and the refund
  // rules are kept by the database itself (the migration that adds
  // payment_status_transitions); what is left here spans tables or time.
  note(
    "하루 넘게 결과를 모르는 주문",
    await ids(
      db
        .selectFrom("payments")
        .select("id")
        .where("status", "=", "pending")
        .where(
          sql<Date>`greatest(created_at, coalesce(charge_attempted_at, created_at))`,
          "<",
          new Date(now.getTime() - DAY_MS),
        ),
    ),
  );
  note(
    "아무 정기 결제도 쓰지 않는 활성 빌링키",
    await ids(
      db
        .selectFrom("billing_keys as k")
        .select("k.id")
        .where("k.status", "=", "active")
        .where("k.created_at", "<", new Date(now.getTime() - DAY_MS))
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("subscriptions as s")
                .select("s.id")
                .whereRef("s.billing_key_id", "=", "k.id"),
            ),
          ),
        ),
    ),
  );
  note(
    "환불 금액이 원장의 취소 합계와 다름",
    await ids(
      db
        .selectFrom("payments as p")
        .select("p.id")
        .where(
          "p.refunded_amount",
          "!=",
          sql<number>`(select coalesce(sum(t.amount), 0)::int from payment_transactions t
            where t.payment_id = p.id and t.kind = 'cancel')`,
        ),
    ),
  );
  note(
    "완료된 결제에 원장의 승인 기록이 없음",
    await ids(
      db
        .selectFrom("payments as p")
        .select("p.id")
        .where("p.status", "in", ["done", "canceled", "partial_canceled"])
        .where("p.paid_at", "is not", null)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("payment_transactions as t")
                .select("t.id")
                .whereRef("t.payment_id", "=", "p.id")
                .where("t.kind", "=", "approval"),
            ),
          ),
        ),
    ),
  );
  note("이용 기한이 결제 원장보다 짧음", await shortenedAccounts());
  return found;
}

// Accounts whose supporter_until ends before what their unrefunded payments
// paid for: paid time a supporter lost. (It may legitimately run later than
// the ledger's replay — a charge granted after a delay starts its period at
// the grant — so only the short side is a violation.)
async function shortenedAccounts(): Promise<string[]> {
  const rows = await db
    .selectFrom("payments")
    .innerJoin("users", "users.id", "payments.user_id")
    .select([
      "payments.user_id",
      "payments.period_start",
      "payments.period_end",
      "payments.paid_at",
      "payments.amount",
      "payments.refunded_amount",
      "users.supporter_until",
    ])
    .where("payments.period_end", "is not", null)
    .execute();
  const byUser = new Map<string, typeof rows>();
  for (const row of rows) {
    byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);
  }
  const shortened: string[] = [];
  for (const [userId, ledger] of byUser) {
    const expected = supporterUntilFromLedger(
      ledger.map((row) => ({
        periodStart: row.period_start,
        periodEnd: row.period_end,
        paidAt: row.paid_at,
        amount: row.amount,
        refundedAmount: row.refunded_amount,
      })),
    );
    const actual = ledger[0].supporter_until
      ? new Date(ledger[0].supporter_until)
      : null;
    if (
      expected &&
      (!actual || actual.getTime() < expected.getTime() - 60 * 1000)
    ) {
      shortened.push(userId);
    }
  }
  return shortened;
}

async function ids(query: {
  execute(): Promise<Array<{ id: string }>>;
}): Promise<string[]> {
  return (await query.execute()).map((row) => row.id);
}

// Records what checkPaymentInvariants found as one operator event.
export async function reportPaymentInvariants(
  now = new Date(),
): Promise<InvariantViolations> {
  const found = await checkPaymentInvariants(now);
  const rules = Object.entries(found);
  if (rules.length > 0) {
    await notePaymentEvent({
      kind: "invariant_violation",
      summary: rules
        .map(
          ([rule, list]) =>
            `${rule} ${list.length}건 (${list.slice(0, 3).join(", ")}${list.length > 3 ? " …" : ""})`,
        )
        .join(" · "),
    });
  }
  return found;
}
