import { db } from "@/lib/database";
import { sendPaymentEventDigestEmail } from "@/lib/email";
import type { Executor } from "@/lib/entitlements";
import { isTossLiveMode, maskBody } from "@/lib/toss";

// Payment and billing events, recorded where they happen and mailed to the
// operators. Recording is unconditional (and /admin lists them); mail goes
// out only in production — where every Toss key is a live key — so test
// payments never reach the inbox.

export const PAYMENT_EVENTS_EMAIL = "hello@naru.pub";

export const PAYMENT_EVENT_LABELS = {
  charge_succeeded: "결제 완료",
  charge_failed: "결제 실패",
  charge_unresolved: "결과 불분명",
  charge_orphaned: "결제됐으나 기간 미부여",
  past_due: "연체 전환",
  refunded: "환불",
  subscription_scheduled: "정기 결제 예약",
  subscription_canceled: "정기 결제 취소",
  card_changed: "결제 카드 변경",
  billing_key_deleted: "빌링키 삭제",
  order_expired: "주문 만료",
  key_deletion_stuck: "빌링키 삭제 지연",
} as const;

export type PaymentEventKind = keyof typeof PAYMENT_EVENT_LABELS;

export function won(amount: number): string {
  return new Intl.NumberFormat("ko-KR").format(amount) + "원";
}

export function kstDate(value: Date | string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

// Records an event in the caller's transaction where there is one, so the
// event exists exactly when the change it describes does.
export async function recordPaymentEvent(
  executor: Executor,
  event: {
    kind: PaymentEventKind;
    summary: string;
    userId?: string | null;
    paymentId?: string | null;
    subscriptionId?: string | null;
  },
): Promise<void> {
  await executor
    .insertInto("payment_events")
    .values({
      kind: event.kind,
      summary: event.summary.slice(0, 2000),
      user_id: event.userId ?? null,
      payment_id: event.paymentId ?? null,
      subscription_id: event.subscriptionId ?? null,
    })
    .execute();
}

// For paths with no transaction to join: an event that cannot be recorded
// must never fail the payment work around it.
export async function notePaymentEvent(
  event: Parameters<typeof recordPaymentEvent>[1],
): Promise<void> {
  try {
    await recordPaymentEvent(db, event);
  } catch (error) {
    console.error("Payment event could not be recorded:", error);
  }
}

// Events are merged into one email while they keep coming: a digest goes out
// once nothing new has arrived for QUIET_MS, or once its oldest event has
// waited MAX_WAIT_MS — so a renewal run, a decline and its grace notice, or a
// refund and the cancel it causes arrive as one message, and none waits long.
const QUIET_MS = 2 * 60 * 1000;
const MAX_WAIT_MS = 15 * 60 * 1000;
const MAX_EVENTS_PER_EMAIL = 300;

function digestSubject(
  events: Array<{ kind: string; loginName: string | null; summary: string }>,
): string {
  if (events.length === 1) {
    const [event] = events;
    const label =
      PAYMENT_EVENT_LABELS[event.kind as PaymentEventKind] ?? event.kind;
    const subject = `[나루 결제] ${event.loginName ?? "(삭제된 계정)"} ${label}: ${event.summary}`;
    return subject.length > 120 ? `${subject.slice(0, 119)}…` : subject;
  }
  const counts = new Map<string, number>();
  for (const event of events) {
    const label =
      PAYMENT_EVENT_LABELS[event.kind as PaymentEventKind] ?? event.kind;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return `[나루 결제] ${events.length}건: ${[...counts]
    .map(([label, count]) => `${label} ${count}`)
    .join(" · ")}`;
}

export type DigestResult =
  | { state: "disabled" }
  | { state: "idle" }
  | { state: "waiting"; pending: number }
  | { state: "sent"; events: number };

export async function sendPaymentEventDigest(
  opts: { now?: Date; enabled?: boolean } = {},
): Promise<DigestResult> {
  if (!(opts.enabled ?? isTossLiveMode())) return { state: "disabled" };
  const now = opts.now ?? new Date();

  return db.transaction().execute(async (trx) => {
    // Locked so two runs can never mail the same events.
    const pending = await trx
      .selectFrom("payment_events")
      .select(["id", "created_at", "kind", "summary", "user_id"])
      .where("emailed_at", "is", null)
      .orderBy("id", "asc")
      .limit(MAX_EVENTS_PER_EMAIL)
      .forUpdate()
      .skipLocked()
      .execute();
    if (pending.length === 0) return { state: "idle" as const };

    const oldest = new Date(pending[0].created_at).getTime();
    const newest = new Date(pending[pending.length - 1].created_at).getTime();
    const quiet = now.getTime() - newest >= QUIET_MS;
    const waitedLongEnough = now.getTime() - oldest >= MAX_WAIT_MS;
    const full = pending.length === MAX_EVENTS_PER_EMAIL;
    if (!quiet && !waitedLongEnough && !full) {
      return { state: "waiting" as const, pending: pending.length };
    }

    const userIds = [
      ...new Set(pending.map((event) => event.user_id).filter((id) => id)),
    ] as string[];
    const users =
      userIds.length > 0
        ? await trx
            .selectFrom("users")
            .select(["id", "login_name"])
            .where("id", "in", userIds)
            .execute()
        : [];
    const loginNames = new Map(users.map((user) => [user.id, user.login_name]));
    const events = pending.map((event) => ({
      createdAt: new Date(event.created_at),
      loginName: event.user_id ? (loginNames.get(event.user_id) ?? null) : null,
      kind: PAYMENT_EVENT_LABELS[event.kind as PaymentEventKind] ?? event.kind,
      rawKind: event.kind,
      summary: event.summary,
    }));

    // Mailed before the rows are marked: if marking fails the transaction
    // rolls back and the next run mails them again. A duplicate digest is
    // better than a lost one.
    await sendPaymentEventDigestEmail({
      to: PAYMENT_EVENTS_EMAIL,
      subject: digestSubject(
        events.map((event) => ({ ...event, kind: event.rawKind })),
      ),
      events,
    });
    await trx
      .updateTable("payment_events")
      .set({ emailed_at: now })
      .where(
        "id",
        "in",
        pending.map((event) => event.id),
      )
      .execute();
    return { state: "sent" as const, events: pending.length };
  });
}

// One row per webhook delivery (see the migration that adds the table).
export async function recordWebhookDelivery(delivery: {
  eventType: string;
  transmissionId: string | null;
  retriedCount: string | null;
  subject: string | null;
  tossStatus: string | null;
  outcome: string;
  httpStatus: number;
  durationMs: number;
  payload: unknown;
  headers?: Record<string, string> | null;
  signature?: string | null;
}): Promise<void> {
  try {
    const retried = Number(delivery.retriedCount);
    await db
      .insertInto("toss_webhook_deliveries")
      .values({
        event_type: delivery.eventType.slice(0, 200),
        transmission_id: delivery.transmissionId?.slice(0, 200) ?? null,
        retried_count:
          delivery.retriedCount != null && Number.isInteger(retried)
            ? retried
            : null,
        subject: delivery.subject?.slice(0, 200) ?? null,
        toss_status: delivery.tossStatus?.slice(0, 64) ?? null,
        outcome: delivery.outcome.slice(0, 2000),
        http_status: delivery.httpStatus,
        duration_ms: delivery.durationMs,
        payload:
          delivery.payload === undefined
            ? null
            : JSON.stringify(maskBody(delivery.payload)).slice(0, 20000),
        headers: delivery.headers
          ? JSON.stringify(delivery.headers).slice(0, 20000)
          : null,
        signature_check: delivery.signature?.slice(0, 500) ?? null,
      })
      .execute();
  } catch (error) {
    // The log must never turn a handled delivery into a failed one.
    console.error("Webhook delivery could not be recorded:", error);
  }
}

const WEBHOOK_DELIVERY_RETENTION_DAYS = 90;
const PAYMENT_EVENT_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// Keeps both logs bounded. Payment events are kept for a year once mailed;
// outside production, where nothing is mailed, they go after the same year.
export async function prunePaymentLogs(now = new Date()) {
  const deliveries = await db
    .deleteFrom("toss_webhook_deliveries")
    .where(
      "received_at",
      "<",
      new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS),
    )
    .executeTakeFirst();
  const events = await db
    .deleteFrom("payment_events")
    .where(
      "created_at",
      "<",
      new Date(now.getTime() - PAYMENT_EVENT_RETENTION_DAYS * DAY_MS),
    )
    .where((eb) =>
      isTossLiveMode() ? eb("emailed_at", "is not", null) : eb.lit(true),
    )
    .executeTakeFirst();
  return {
    deliveries: Number(deliveries.numDeletedRows ?? 0),
    events: Number(events.numDeletedRows ?? 0),
  };
}
