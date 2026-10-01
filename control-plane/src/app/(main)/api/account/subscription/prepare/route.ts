import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import {
  EMAIL_VERIFICATION_REQUIRED_MESSAGE,
  hasVerifiedEmail,
} from "@/lib/support";
import { assertJsonContentType } from "@/lib/utils";
import { isBillingInterval } from "@/lib/toss";
import { prepareSubscription } from "@/lib/subscription-signup";

// Step 1 of the subscribe flow: records the chosen plan as an incomplete
// subscription and returns the stable Toss customerKey for requestBillingAuth.
export async function POST(request: NextRequest) {
  try {
    try {
      assertJsonContentType(request);
    } catch {
      return NextResponse.json(
        { success: false, message: "Invalid content type" },
        { status: 400 },
      );
    }

    const { user } = await validateRequest();
    if (!user) {
      return NextResponse.json(
        { success: false, message: "로그인이 필요합니다." },
        { status: 401 },
      );
    }

    if (!hasVerifiedEmail(user)) {
      return NextResponse.json(
        { success: false, message: EMAIL_VERIFICATION_REQUIRED_MESSAGE },
        { status: 403 },
      );
    }

    const { interval } = await request.json();
    if (!isBillingInterval(interval)) {
      return NextResponse.json(
        { success: false, message: "유효하지 않은 결제 주기입니다." },
        { status: 400 },
      );
    }

    const result = await prepareSubscription({ userId: user.id, interval });
    if (!result.ok) {
      return NextResponse.json(
        { success: false, message: result.message },
        { status: result.status },
      );
    }
    return NextResponse.json({
      success: true,
      customerKey: result.customerKey,
    });
  } catch (error) {
    console.error("Subscription prepare error:", error);
    return NextResponse.json(
      { success: false, message: "결제 준비 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
