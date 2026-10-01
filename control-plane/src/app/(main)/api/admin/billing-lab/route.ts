import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { LabAction, LabError, runLabAction } from "@/lib/billing-lab";
import { PAYMENT_OPERATOR_USERS } from "@/lib/support";
import { isTossTestMode } from "@/lib/toss";
import { assertJsonContentType } from "@/lib/utils";

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function testCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z_]{0,64}$/.test(value)
    ? value || undefined
    : undefined;
}

function parseAction(body: Record<string, unknown>): LabAction | null {
  const subscriptionId = positiveInt(body.subscriptionId);
  const paymentId = positiveInt(body.paymentId);
  const userId = positiveInt(body.userId);
  switch (body.action) {
    case "inspect":
      return userId ? { action: "inspect", userId } : null;
    case "charge":
      return subscriptionId
        ? {
            action: "charge",
            subscriptionId,
            testCode: testCode(body.testCode),
          }
        : null;
    case "advance":
      return subscriptionId &&
        (body.to === "period_end" || body.to === "past_grace")
        ? { action: "advance", subscriptionId, to: body.to }
        : null;
    case "reconcile":
    case "refund":
      return paymentId
        ? { action: body.action, paymentId, testCode: testCode(body.testCode) }
        : null;
    case "payment-webhook":
      return paymentId ? { action: "payment-webhook", paymentId } : null;
    case "billing-deleted":
      return subscriptionId
        ? { action: "billing-deleted", subscriptionId }
        : null;
    case "process-key-queue":
      return { action: "process-key-queue", userId: userId ?? undefined };
    default:
      return null;
  }
}

// The billing lab (lib/billing-lab.ts). Payment operators only, and only where
// every Toss key is a test key: these actions charge and refund for real.
export async function POST(request: NextRequest) {
  try {
    assertJsonContentType(request);
  } catch {
    return NextResponse.json(
      { success: false, message: "잘못된 요청입니다." },
      { status: 400 },
    );
  }

  const { user } = await validateRequest();
  if (!user || !PAYMENT_OPERATOR_USERS.has(user.loginName)) {
    return NextResponse.json(
      { success: false, message: "찾을 수 없습니다." },
      { status: 404 },
    );
  }
  if (!isTossTestMode()) {
    return NextResponse.json(
      {
        success: false,
        message: "테스트 키(test_…)로 설정된 환경에서만 쓸 수 있습니다.",
      },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => null);
  const action =
    body && typeof body === "object"
      ? parseAction(body as Record<string, unknown>)
      : null;
  if (!action) {
    return NextResponse.json(
      { success: false, message: "알 수 없는 실험입니다." },
      { status: 400 },
    );
  }

  try {
    const result = await runLabAction(action);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    if (error instanceof LabError) {
      return NextResponse.json(
        { success: false, message: error.message },
        { status: 409 },
      );
    }
    console.error("Billing lab error:", error);
    return NextResponse.json(
      { success: false, message: "실험을 실행하지 못했습니다." },
      { status: 500 },
    );
  }
}
