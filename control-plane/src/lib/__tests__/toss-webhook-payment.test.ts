import { describe, expect, test } from "@jest/globals";
import {
  isTrustedWebhookSource,
  parseTossWebhook,
  webhookLedgerAction,
} from "@/lib/toss-webhooks";

describe("Toss webhook parsing", () => {
  test("accepts payment status events", () => {
    expect(
      parseTossWebhook({
        eventType: "PAYMENT_STATUS_CHANGED",
        data: { orderId: "order-1", status: "DONE" },
      }),
    ).toEqual({ type: "payment-status-changed", orderId: "order-1" });
  });

  // Toss nests the payload under data, as for every other event.
  test("accepts billing-key deletion events", () => {
    expect(
      parseTossWebhook({
        eventType: "BILLING_DELETED",
        createdAt: "2026-09-30T12:00:00.000000",
        data: { billingKey: "billing-1", reason: "customer request" },
      }),
    ).toEqual({ type: "billing-deleted", billingKey: "billing-1" });
  });

  test.each([
    null,
    {},
    { eventType: "BILLING_DELETED" },
    { eventType: "BILLING_DELETED", data: {} },
    { eventType: "BILLING_DELETED", data: { billingKey: "" } },
    // Not where Toss puts it.
    { eventType: "BILLING_DELETED", billingKey: "billing-1" },
    { eventType: "DEPOSIT_CALLBACK", orderId: "order-1" },
  ])("ignores unsupported or malformed payloads", (payload) => {
    expect(parseTossWebhook(payload)).toEqual({ type: "ignored" });
  });
});

describe("Toss webhook ledger updates", () => {
  test.each(["READY", "IN_PROGRESS", "WAITING_FOR_DEPOSIT", "DONE"])(
    "leaves a %s payment pending for confirm and reconciliation",
    (status) => {
      expect(webhookLedgerAction(status)).toEqual({ type: "record" });
    },
  );

  test.each(["ABORTED", "EXPIRED", "FAILED"])(
    "fails a pending payment on %s",
    (status) => {
      expect(webhookLedgerAction(status)).toEqual({
        type: "fail",
        status: status.toLowerCase(),
      });
    },
  );

  test.each(["CANCELED", "PARTIAL_CANCELED"])(
    "reconciles a %s payment",
    (status) => {
      expect(webhookLedgerAction(status)).toEqual({ type: "reconcile" });
    },
  );
});

// BILLING_DELETED cancels a subscription without any lookup to confirm it.
describe("Toss webhook sender", () => {
  test("accepts Toss's published addresses behind a trusted ingress", () => {
    expect(isTrustedWebhookSource("13.124.18.147", true)).toBe(true);
    expect(isTrustedWebhookSource("115.92.221.127", true)).toBe(true);
  });

  test.each([null, "", "203.0.113.9", "115.92.221.124"])(
    "refuses %p behind a trusted ingress",
    (ip) => {
      expect(isTrustedWebhookSource(ip, true)).toBe(false);
    },
  );

  // Without an ingress that overwrites the header, anyone could claim a Toss
  // address, so the header is not consulted at all.
  test("does not check a header the caller controls", () => {
    expect(isTrustedWebhookSource(null, false)).toBe(true);
    expect(isTrustedWebhookSource("203.0.113.9", false)).toBe(true);
  });
});
