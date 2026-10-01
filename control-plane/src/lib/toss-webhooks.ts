import { createHmac, timingSafeEqual } from "crypto";
import type { TossPaymentFlow } from "@/lib/toss";

export type TossWebhookEvent =
  | { type: "payment-status-changed"; orderId: string }
  | { type: "billing-deleted"; billingKey: string }
  | { type: "ignored" };

export function parseTossWebhook(body: unknown): TossWebhookEvent {
  if (!body || typeof body !== "object") return { type: "ignored" };

  const event = body as Record<string, unknown>;
  // Toss nests every event's payload under data: BILLING_DELETED is
  // { eventType, createdAt, data: { billingKey, reason } }.
  if (event.eventType === "BILLING_DELETED") {
    const data = event.data;
    const billingKey =
      data && typeof data === "object"
        ? (data as Record<string, unknown>).billingKey
        : undefined;
    return typeof billingKey === "string" && billingKey
      ? { type: "billing-deleted", billingKey }
      : { type: "ignored" };
  }

  if (event.eventType !== "PAYMENT_STATUS_CHANGED") {
    return { type: "ignored" };
  }

  const data = event.data;
  if (!data || typeof data !== "object") return { type: "ignored" };
  const orderId = (data as Record<string, unknown>).orderId;
  return typeof orderId === "string"
    ? { type: "payment-status-changed", orderId }
    : { type: "ignored" };
}

// The ledger only knows pending, done and the terminal states, and every other
// path (confirm, the reconciler) acts only on pending rows. A webhook for an
// intermediate status — READY, IN_PROGRESS, WAITING_FOR_DEPOSIT — must leave the
// row pending, or the payment can never be confirmed or reconciled. DONE also
// leaves it pending: granting the paid period belongs to confirm, the renewal
// cron and the reconciler. Cancellations go through reconciliation instead.
const TERMINAL_FAILURE_STATUSES = new Set(["aborted", "expired", "failed"]);

export type WebhookLedgerAction =
  | { type: "reconcile" }
  | { type: "fail"; status: string }
  | { type: "record" };

export function webhookLedgerAction(tossStatus: string): WebhookLedgerAction {
  const status = tossStatus.toLowerCase();
  if (status === "canceled" || status === "partial_canceled") {
    return { type: "reconcile" };
  }
  if (TERMINAL_FAILURE_STATUSES.has(status)) {
    return { type: "fail", status };
  }
  return { type: "record" };
}

// The addresses Toss sends webhooks from
// (https://docs.tosspayments.com/reference/using-api/security).
const TOSS_WEBHOOK_IPS = new Set([
  "13.124.18.147",
  "13.124.108.35",
  "3.36.173.151",
  "3.38.81.32",
  "115.92.221.121",
  "115.92.221.122",
  "115.92.221.123",
  "115.92.221.125",
  "115.92.221.126",
  "115.92.221.127",
]);

// BILLING_DELETED is unsigned and, unlike a payment event, cannot be checked
// against the API — Toss has no lookup for billing keys. The sender's address
// is the one thing left to check, and only where the ingress overwrites
// CF-Connecting-IP (SITE_DATA_TRUST_CLOUDFLARE_IP, see docs/database.md);
// anywhere else the header is the caller's to forge, so no check is made.
export function isTrustedWebhookSource(
  cfConnectingIp: string | null,
  trustForwardedIp = process.env.SITE_DATA_TRUST_CLOUDFLARE_IP === "1",
): boolean {
  if (!trustForwardedIp) return true;
  return cfConnectingIp != null && TOSS_WEBHOOK_IPS.has(cfConnectingIp.trim());
}

// The headers a delivery is stored with: everything Toss sent, minus what
// could carry a credential. Whether payment and billing events are signed is
// read from these (see the migration that adds the column).
const UNSTORED_HEADERS = new Set(["authorization", "cookie"]);

export function storedWebhookHeaders(headers: Headers): Record<string, string> {
  const stored: Record<string, string> = {};
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (!UNSTORED_HEADERS.has(key)) stored[key] = value;
  });
  return stored;
}

// The names of any signature headers, for the log line: a signed delivery
// shows up in the logs without anyone reading the table.
export function signatureHeaderNames(
  headers: Record<string, string>,
): string[] {
  return Object.keys(headers)
    .filter((name) => name.includes("signature"))
    .sort();
}

// Which secret key, over which string, produced a delivery's signature —
// found by trying them, because the docs do not settle it. The webhook pages
// sign `{payload}:{tosspayments-webhook-transmission-time}` with the payouts
// security key, for payout and seller events only, in
// tosspayments-webhook-signature as `v1:<base64>` values (up to four while a
// key is being reissued). A 2024-09 release note instead says every event
// carries a Toss-Signature made with the secret key. So both signed strings
// are tried against both of 나루's secret keys, and every `v1:` value in any
// signature header. Nothing is rejected on this yet: the result is logged and
// stored until real deliveries show which one Toss uses.
const SIGNED_STRINGS: Array<{
  name: string;
  build: (rawBody: string, transmissionTime: string | null) => string | null;
}> = [
  {
    name: "payload:time",
    build: (rawBody, time) => (time ? `${rawBody}:${time}` : null),
  },
  { name: "payload", build: (rawBody) => rawBody },
];

function signatureValues(header: string): Buffer[] {
  return header
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^v1:/, ""))
    .map((value) => Buffer.from(value, "base64"))
    .filter((value) => value.length > 0);
}

export function checkWebhookSignature(opts: {
  rawBody: string;
  headers: Record<string, string>;
  keys: Array<{ flow: TossPaymentFlow; key: string }>;
}): string | null {
  const names = signatureHeaderNames(opts.headers);
  if (names.length === 0) return null;
  const time = opts.headers["tosspayments-webhook-transmission-time"] ?? null;
  for (const name of names) {
    const values = signatureValues(opts.headers[name]);
    for (const { flow, key } of opts.keys) {
      for (const signed of SIGNED_STRINGS) {
        const message = signed.build(opts.rawBody, time);
        if (message == null) continue;
        const expected = createHmac("sha256", key).update(message).digest();
        if (
          values.some(
            (value) =>
              value.length === expected.length &&
              timingSafeEqual(value, expected),
          )
        ) {
          return `${name} verified (${flow} key, ${signed.name})`;
        }
      }
    }
  }
  return `${names.join(",")} unverified`;
}

// What one webhook delivery was and what became of it, logged as one line so
// a delivery that changed nothing is as visible as one that failed.
export type WebhookLogEntry = {
  eventType: string;
  transmissionId: string | null;
  retriedCount: string | null;
  // Signature headers and whether one verified (checkWebhookSignature), when
  // the delivery had any.
  signature: string | null;
  // The orderId, or the billing key (masked) for BILLING_DELETED.
  subject: string | null;
  tossStatus: string | null;
  outcome: string;
  httpStatus: number;
  durationMs: number;
};

export function formatWebhookLog(entry: WebhookLogEntry): string {
  const fields = [
    ["id", entry.transmissionId],
    ["retry", entry.retriedCount],
    ["signature", entry.signature],
    ["subject", entry.subject],
    ["toss", entry.tossStatus],
  ]
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => `${key}=${value}`);
  return `[toss-webhook] ${[entry.eventType, ...fields].join(" ")} -> ${entry.outcome} (${entry.httpStatus}, ${entry.durationMs}ms)`;
}
