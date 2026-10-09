import { createHmac, timingSafeEqual } from "crypto";
import type { TossPaymentFlow } from "@/lib/payments/toss";

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
// CF-Connecting-IP (TRUST_CLOUDFLARE_IP, see docs/database.md);
// anywhere else the header is the caller's to forge, so no check is made.
export function isTrustedWebhookSource(
  cfConnectingIp: string | null,
  trustForwardedIp = process.env.TRUST_CLOUDFLARE_IP === "1",
): boolean {
  if (!trustForwardedIp) return true;
  return cfConnectingIp != null && TOSS_WEBHOOK_IPS.has(cfConnectingIp.trim());
}

// A Toss webhook body is a few hundred bytes — a Payment object at most. The
// endpoint is public and reads the body before anything about the sender is
// known, so anything far larger is refused unread.
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

// Reads the body up to `limit` bytes; null when it is longer, without reading
// the rest.
export async function readCappedBody(
  request: Request,
  limit = MAX_WEBHOOK_BODY_BYTES,
): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The headers a delivery is stored with: what Toss sent, minus what could
// carry a credential, and bounded — the sender is anyone until proven
// otherwise.
const UNSTORED_HEADERS = new Set(["authorization", "cookie"]);
const MAX_STORED_HEADERS = 50;
const MAX_STORED_HEADER_LENGTH = 1000;

export function storedWebhookHeaders(headers: Headers): Record<string, string> {
  const stored: Record<string, string> = {};
  let count = 0;
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (UNSTORED_HEADERS.has(key) || count >= MAX_STORED_HEADERS) return;
    stored[key] = value.slice(0, MAX_STORED_HEADER_LENGTH);
    count += 1;
  });
  return stored;
}

// The two signature headers Toss documents. Only these are read: a header is
// the sender's to invent, and every one checked costs HMACs over the body.
const SIGNATURE_HEADERS = ["toss-signature", "tosspayments-webhook-signature"];
// Toss sends up to four values while a key is being reissued.
const MAX_SIGNATURE_VALUES = 4;

// The signature headers a delivery came with, for the log line: a signed
// delivery shows up in the logs without anyone reading the table. Real Toss
// payment and billing webhooks have carried none (docs/billing.md); this is
// kept to notice if live keys change that.
export function signatureHeaderNames(
  headers: Record<string, string>,
): string[] {
  return SIGNATURE_HEADERS.filter((name) => name in headers);
}

// Which secret key, over which string, produced a delivery's signature —
// found by trying them, because the docs do not settle it. The webhook pages
// sign `{payload}:{tosspayments-webhook-transmission-time}` with the payouts
// security key, for payout and seller events only, in
// tosspayments-webhook-signature as `v1:<base64>` values. A 2024-09 release
// note instead says every event carries a Toss-Signature made with the secret
// key. Both signed strings are tried against both of 나루's secret keys — four
// HMACs at most, whatever the request — and compared with every value of the
// two headers. Nothing is rejected on this: real deliveries have been
// unsigned.
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
    .slice(0, MAX_SIGNATURE_VALUES)
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
  const candidates = names.flatMap((name) =>
    signatureValues(opts.headers[name]).map((value) => ({ name, value })),
  );
  for (const { flow, key } of opts.keys) {
    for (const signed of SIGNED_STRINGS) {
      const message = signed.build(opts.rawBody, time);
      if (message == null) continue;
      const expected = createHmac("sha256", key).update(message).digest();
      const match = candidates.find(
        ({ value }) =>
          value.length === expected.length && timingSafeEqual(value, expected),
      );
      if (match) {
        return `${match.name} verified (${flow} key, ${signed.name})`;
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
