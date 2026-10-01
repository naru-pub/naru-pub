import { db } from "@/lib/database";
import {
  operatorAlertsConfigured,
  sendOperatorAlert,
} from "@/lib/operator-alerts";
import type { Executor } from "@/lib/entitlements";
import { isTossLiveMode, maskBody } from "@/lib/payments/toss";

// Payment and billing events, recorded where they happen and posted to the
// operators' Discord channel (lib/operator-alerts). Recording is unconditional
// (and /admin lists them); they are posted only in production — where every
// Toss key is a live key — so test payments never reach the channel.

export const PAYMENT_EVENT_LABELS = {
  charge_succeeded: "결제 완료",
  charge_failed: "결제 실패",
  charge_unresolved: "결과 불분명",
  charge_orphaned: "결제됐으나 기간 미부여",
  card_registration_failed: "카드 등록 실패",
  billing_mid_mismatch: "빌링키 MID 불일치",
  past_due: "연체 전환",
  refunded: "환불",
  subscription_scheduled: "정기 결제 예약",
  subscription_canceled: "정기 결제 취소",
  card_changed: "결제 카드 변경",
  billing_key_deleted: "빌링키 삭제",
  order_expired: "주문 만료",
  key_deletion_stuck: "빌링키 삭제 지연",
  job_failed: "결제 작업 실패",
  invariant_violation: "결제 데이터 이상",
  toss_mismatch: "Toss 거래 불일치",
} as const;

export type PaymentEventKind = keyof typeof PAYMENT_EVENT_LABELS;

// Failures: a payment that did not go through or whose outcome is unknown, a
// supporter falling past due, and the payment machinery itself going wrong.
// These reach the operators at once and in test mode too; the rest wait for a
// quiet moment and are posted only in live mode.
export const FAILURE_EVENT_KINDS: ReadonlySet<PaymentEventKind> = new Set([
  "charge_failed",
  "charge_unresolved",
  "charge_orphaned",
  "card_registration_failed",
  "billing_mid_mismatch",
  "past_due",
  "key_deletion_stuck",
  "job_failed",
  "invariant_violation",
  "toss_mismatch",
] as const);

function isFailure(kind: string): boolean {
  return FAILURE_EVENT_KINDS.has(kind as PaymentEventKind);
}

export function won(amount: number): string {
  return new Intl.NumberFormat("ko-KR").format(amount) + "원";
}

export function kstDate(value: Date | string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function kstTime(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(value);
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

// Events are merged into one message while they keep coming: a digest goes out
// once nothing new has arrived for QUIET_MS, or once its oldest event has
// waited MAX_WAIT_MS — so a renewal run, or a refund and the cancel it causes,
// arrive as one message, and none waits long. A failure does not wait: the
// next run (every minute) posts it with whatever else is pending.
const QUIET_MS = 2 * 60 * 1000;
const MAX_WAIT_MS = 15 * 60 * 1000;
const MAX_EVENTS_PER_DIGEST = 300;

function digestSubject(
  events: Array<{ kind: string; loginName: string | null; summary: string }>,
  live: boolean,
): string {
  const tag = live ? "[나루 결제]" : "[나루 결제·테스트]";
  if (events.length === 1) {
    const [event] = events;
    const label =
      PAYMENT_EVENT_LABELS[event.kind as PaymentEventKind] ?? event.kind;
    const subject = `${tag} ${event.loginName ?? "(삭제된 계정)"} ${label}: ${event.summary}`;
    return subject.length > 120 ? `${subject.slice(0, 119)}…` : subject;
  }
  const counts = new Map<string, number>();
  for (const event of events) {
    const label =
      PAYMENT_EVENT_LABELS[event.kind as PaymentEventKind] ?? event.kind;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return `${tag} ${events.length}건: ${[...counts]
    .map(([label, count]) => `${label} ${count}`)
    .join(" · ")}`;
}

export type DigestResult =
  | { state: "disabled" }
  | { state: "idle" }
  | { state: "waiting"; pending: number }
  | { state: "sent"; events: number };

// In test mode (any Toss key not live) only failures are posted; the routine
// events stay unposted, shown as such on /admin/events.
export async function sendPaymentEventDigest(
  opts: { now?: Date; enabled?: boolean; live?: boolean } = {},
): Promise<DigestResult> {
  if (!(opts.enabled ?? operatorAlertsConfigured())) {
    return { state: "disabled" };
  }
  const live = opts.live ?? isTossLiveMode();
  const now = opts.now ?? new Date();

  return db.transaction().execute(async (trx) => {
    // Locked so two runs can never post the same events.
    const pending = await trx
      .selectFrom("payment_events")
      .select(["id", "created_at", "kind", "summary", "user_id"])
      .where("notified_at", "is", null)
      .$if(!live, (qb) => qb.where("kind", "in", [...FAILURE_EVENT_KINDS]))
      .orderBy("id", "asc")
      .limit(MAX_EVENTS_PER_DIGEST)
      .forUpdate()
      .skipLocked()
      .execute();
    if (pending.length === 0) return { state: "idle" as const };

    const oldest = new Date(pending[0].created_at).getTime();
    const newest = new Date(pending[pending.length - 1].created_at).getTime();
    const quiet = now.getTime() - newest >= QUIET_MS;
    const waitedLongEnough = now.getTime() - oldest >= MAX_WAIT_MS;
    const full = pending.length === MAX_EVENTS_PER_DIGEST;
    const failure = pending.some((event) => isFailure(event.kind));
    if (!quiet && !waitedLongEnough && !full && !failure) {
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
    // Posted before the rows are marked: if marking fails the transaction
    // rolls back and the next run posts them again. A duplicate digest is
    // better than a lost one.
    await sendOperatorAlert({
      title: digestSubject(
        pending.map((event) => ({
          kind: event.kind,
          loginName: event.user_id
            ? (loginNames.get(event.user_id) ?? null)
            : null,
          summary: event.summary,
        })),
        live,
      ),
      lines: pending.map((event) => {
        const who = event.user_id
          ? (loginNames.get(event.user_id) ?? "(삭제된 계정)")
          : "-";
        const label =
          PAYMENT_EVENT_LABELS[event.kind as PaymentEventKind] ?? event.kind;
        return `${kstTime(new Date(event.created_at))} ${who} [${label}] ${event.summary}`;
      }),
      more: `${process.env.BASE_URL ?? ""}/admin/events`,
    });
    await trx
      .updateTable("payment_events")
      .set({ notified_at: now })
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

// Webhook deliveries, Toss calls and payment window outcomes are the raw evidence of what Toss said and
// when — for a dispute or an audit — and carry some personal data (names,
// masked card numbers), so they are kept as long as payment records must be
// (전자상거래법: 5 years) and Toss answers lookups, and no longer.
const RAW_PAYMENT_LOG_RETENTION_DAYS = 5 * 365;
const PAYMENT_EVENT_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// Keeps the logs bounded. Payment events are kept for a year once posted;
// outside production, where nothing is posted, they go after the same year.
export async function prunePaymentLogs(now = new Date()) {
  const deliveries = await db
    .deleteFrom("toss_webhook_deliveries")
    .where(
      "received_at",
      "<",
      new Date(now.getTime() - RAW_PAYMENT_LOG_RETENTION_DAYS * DAY_MS),
    )
    .executeTakeFirst();
  const calls = await db
    .deleteFrom("toss_calls")
    .where(
      "created_at",
      "<",
      new Date(now.getTime() - RAW_PAYMENT_LOG_RETENTION_DAYS * DAY_MS),
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
      isTossLiveMode() ? eb("notified_at", "is not", null) : eb.lit(true),
    )
    .executeTakeFirst();
  const windows = await db
    .deleteFrom("toss_window_outcomes")
    .where(
      "created_at",
      "<",
      new Date(now.getTime() - RAW_PAYMENT_LOG_RETENTION_DAYS * DAY_MS),
    )
    .executeTakeFirst();
  // Mail and cron records answer support questions about the last year; the
  // mail ones hold addresses.
  const yearAgo = new Date(
    now.getTime() - PAYMENT_EVENT_RETENTION_DAYS * DAY_MS,
  );
  const mails = await db
    .deleteFrom("payment_mails")
    .where("created_at", "<", yearAgo)
    .executeTakeFirst();
  const runs = await db
    .deleteFrom("payment_cron_runs")
    .where("started_at", "<", yearAgo)
    .executeTakeFirst();
  return {
    deliveries: Number(deliveries.numDeletedRows ?? 0),
    tossCalls: Number(calls.numDeletedRows ?? 0),
    windows: Number(windows.numDeletedRows ?? 0),
    events: Number(events.numDeletedRows ?? 0),
    mails: Number(mails.numDeletedRows ?? 0),
    cronRuns: Number(runs.numDeletedRows ?? 0),
  };
}

// One run of a payment cron job (cli/cron.ts), so "did the 09:00 renewal run,
// and what did it do" has an answer after the container's log is gone. Best
// effort: a run that cannot be recorded is still a run.
export async function recordPaymentCronRun(run: {
  script: string;
  startedAt: Date;
  exitCode: number | null;
  timedOut: boolean;
  outputTail: string;
}): Promise<void> {
  try {
    await db
      .insertInto("payment_cron_runs")
      .values({
        script: run.script,
        started_at: run.startedAt,
        finished_at: new Date(),
        exit_code: run.exitCode,
        timed_out: run.timedOut,
        output_tail: run.outputTail.slice(-4000) || null,
      })
      .execute();
  } catch (error) {
    console.error("Payment cron run could not be recorded:", error);
  }
}
