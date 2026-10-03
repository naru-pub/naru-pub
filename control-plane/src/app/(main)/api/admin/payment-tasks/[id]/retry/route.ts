import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import {
  retryPaymentTask,
  TaskRecoveryError,
} from "@/lib/payments/task-recovery";
import { parseUuid } from "@/lib/uuid";
import { assertJsonContentType } from "@/lib/utils";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { user } = await validateRequest();
  if (!user) return NextResponse.json({ success: false }, { status: 401 });
  if (!PAYMENT_OPERATOR_USERS.has(user.loginName))
    return NextResponse.json({ success: false }, { status: 403 });
  try {
    try {
      assertJsonContentType(request);
    } catch {
      return NextResponse.json({ success: false }, { status: 400 });
    }
    const id = parseUuid((await context.params).id);
    if (!id) return NextResponse.json({ success: false }, { status: 400 });
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false }, { status: 400 });
    }
    if (typeof body?.reason !== "string")
      return NextResponse.json({ success: false }, { status: 400 });
    const result = await retryPaymentTask(id, user, body.reason);
    return NextResponse.json({ success: true, result }, { status: 202 });
  } catch (error) {
    if (error instanceof TaskRecoveryError)
      return NextResponse.json(
        { success: false, message: error.message },
        { status: error.status },
      );
    console.error("Payment task recovery failed", error);
    return NextResponse.json(
      { success: false, message: "작업을 다시 시작하지 못했습니다." },
      { status: 503 },
    );
  }
}
