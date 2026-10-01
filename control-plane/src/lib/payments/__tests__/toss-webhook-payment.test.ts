/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import { createHmac } from "crypto";
import {
  checkWebhookSignature,
  formatWebhookLog,
  isTrustedWebhookSource,
  MAX_WEBHOOK_BODY_BYTES,
  parseTossWebhook,
  readCappedBody,
  signatureHeaderNames,
  storedWebhookHeaders,
  webhookLedgerAction,
} from "@/lib/payments/toss-webhooks";

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

describe("Toss webhook log line", () => {
  test("says what arrived and what was done with it", () => {
    expect(
      formatWebhookLog({
        eventType: "PAYMENT_STATUS_CHANGED",
        transmissionId: "whtrans_1",
        retriedCount: "2",
        signature: null,
        subject: "2026-10-01-1234-5678",
        tossStatus: "CANCELED",
        outcome: 'reconciled payment 7: {"state":"refunded"}',
        httpStatus: 200,
        durationMs: 41,
      }),
    ).toBe(
      '[toss-webhook] PAYMENT_STATUS_CHANGED id=whtrans_1 retry=2 subject=2026-10-01-1234-5678 toss=CANCELED -> reconciled payment 7: {"state":"refunded"} (200, 41ms)',
    );
  });

  test("leaves out what is not known", () => {
    expect(
      formatWebhookLog({
        eventType: "(unparsed)",
        transmissionId: null,
        retriedCount: null,
        signature: null,
        subject: null,
        tossStatus: null,
        outcome: "ignored: malformed JSON",
        httpStatus: 200,
        durationMs: 0,
      }),
    ).toBe("[toss-webhook] (unparsed) -> ignored: malformed JSON (200, 0ms)");
  });

  test("names the signature headers a delivery came with", () => {
    expect(
      formatWebhookLog({
        eventType: "BILLING_DELETED",
        transmissionId: "whtrans_2",
        retriedCount: "0",
        signature: "toss-signature",
        subject: "abcd••••wxyz",
        tossStatus: null,
        outcome: "canceled subscription 1",
        httpStatus: 200,
        durationMs: 5,
      }),
    ).toBe(
      "[toss-webhook] BILLING_DELETED id=whtrans_2 retry=0 signature=toss-signature subject=abcd••••wxyz -> canceled subscription 1 (200, 5ms)",
    );
  });
});

describe("Toss webhook headers", () => {
  test("keeps what Toss sent but nothing that could carry a credential", () => {
    const stored = storedWebhookHeaders(
      new Headers({
        "Content-Type": "application/json",
        "Toss-Signature": "v1:abc",
        "tosspayments-webhook-transmission-id": "whtrans_1",
        Authorization: "Basic secret",
        Cookie: "session=1",
      }),
    );

    expect(stored).toEqual({
      "content-type": "application/json",
      "toss-signature": "v1:abc",
      "tosspayments-webhook-transmission-id": "whtrans_1",
    });
    expect(signatureHeaderNames(stored)).toEqual(["toss-signature"]);
  });

  test("finds no signature where there is none", () => {
    expect(
      signatureHeaderNames({ "content-type": "application/json" }),
    ).toEqual([]);
  });
});

describe("Toss webhook signature check", () => {
  const keys = [
    { flow: "billing" as const, key: "live_sk_billing" },
    { flow: "one-time" as const, key: "live_sk_payment" },
  ];
  const rawBody = '{"eventType":"BILLING_DELETED","data":{"billingKey":"k"}}';
  const time = "2026-10-01T14:00:00+09:00";
  const sign = (key: string, message: string) =>
    createHmac("sha256", key).update(message).digest("base64");

  test("verifies the documented payload:time form", () => {
    expect(
      checkWebhookSignature({
        rawBody,
        headers: {
          "tosspayments-webhook-transmission-time": time,
          "tosspayments-webhook-signature": `v1:${sign("live_sk_billing", `${rawBody}:${time}`)}`,
        },
        keys,
      }),
    ).toBe(
      "tosspayments-webhook-signature verified (billing key, payload:time)",
    );
  });

  test("verifies the body alone, and any of several values", () => {
    expect(
      checkWebhookSignature({
        rawBody,
        headers: {
          "toss-signature": `v1:${sign("other", rawBody)}, v1:${sign("live_sk_payment", rawBody)}`,
        },
        keys,
      }),
    ).toBe("toss-signature verified (one-time key, payload)");
  });

  test("reports a signature none of the keys made", () => {
    expect(
      checkWebhookSignature({
        rawBody,
        headers: {
          "tosspayments-webhook-transmission-time": time,
          "toss-signature": `v1:${sign("someone else", rawBody)}`,
        },
        keys,
      }),
    ).toBe("toss-signature unverified");
  });

  test("a body changed after signing does not verify", () => {
    expect(
      checkWebhookSignature({
        rawBody: rawBody.replace('"k"', '"x"'),
        headers: { "toss-signature": `v1:${sign("live_sk_billing", rawBody)}` },
        keys,
      }),
    ).toBe("toss-signature unverified");
  });

  test("says nothing of a delivery without a signature", () => {
    expect(
      checkWebhookSignature({
        rawBody,
        headers: { "content-type": "application/json" },
        keys,
      }),
    ).toBeNull();
  });
});

describe("Toss webhook request limits", () => {
  test("only the two documented signature headers are read", () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) headers[`x${i}-signature`] = "v1:AAAA";
    expect(signatureHeaderNames(headers)).toEqual([]);
    expect(
      checkWebhookSignature({
        rawBody: "{}",
        headers,
        keys: [{ flow: "billing" as const, key: "k" }],
      }),
    ).toBeNull();
  });

  // Built from real Headers and a stream rather than `new Request`: the
  // default Jest setup (jest.setup.js) swaps Request for a bare mock.
  function webhookRequest(body: string, headers: Record<string, string> = {}) {
    return {
      headers: new Headers(headers),
      body: new Response(body).body,
    } as unknown as Request;
  }

  test("a body past the limit is refused unread", async () => {
    expect(
      await readCappedBody(
        webhookRequest("x".repeat(MAX_WEBHOOK_BODY_BYTES + 1)),
      ),
    ).toBeNull();
    expect(
      await readCappedBody(
        webhookRequest("{}", {
          "content-length": String(10 * 1024 * 1024),
        }),
      ),
    ).toBeNull();
    expect(
      await readCappedBody(webhookRequest('{"eventType":"BILLING_DELETED"}')),
    ).toBe('{"eventType":"BILLING_DELETED"}');
  });

  test("stored headers are bounded", () => {
    const headers = new Headers();
    for (let i = 0; i < 200; i++) headers.set(`x-h${i}`, "v".repeat(5000));
    const stored = storedWebhookHeaders(headers);
    expect(Object.keys(stored).length).toBeLessThanOrEqual(50);
    expect(Object.values(stored).every((value) => value.length <= 1000)).toBe(
      true,
    );
  });
});
