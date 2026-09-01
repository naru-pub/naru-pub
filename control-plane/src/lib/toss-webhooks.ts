export type TossWebhookEvent =
  | { type: "payment-status-changed"; orderId: string }
  | { type: "billing-deleted"; billingKey: string }
  | { type: "ignored" };

export function parseTossWebhook(body: unknown): TossWebhookEvent {
  if (!body || typeof body !== "object") return { type: "ignored" };

  const event = body as Record<string, unknown>;
  if (
    event.eventType === "BILLING_DELETED" &&
    typeof event.billingKey === "string"
  ) {
    return { type: "billing-deleted", billingKey: event.billingKey };
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
