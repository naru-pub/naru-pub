import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { assertJsonContentType } from "@/lib/utils";
import { confirmSubscription } from "@/lib/subscription-signup";

// Step 2 of the subscribe flow: exchanges the authKey for a billing key. When
// prepaid access remains, the first charge is scheduled for its expiry;
// otherwise the first period is charged immediately.
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

    const { authKey, customerKey } = await request.json();
    if (typeof authKey !== "string" || typeof customerKey !== "string") {
      return NextResponse.json(
        { success: false, message: "유효하지 않은 요청입니다." },
        { status: 400 },
      );
    }

    const result = await confirmSubscription({
      userId: user.id,
      authKey,
      customerKey,
    });
    if (!result.ok) {
      return NextResponse.json(
        { success: false, message: result.message },
        { status: result.status },
      );
    }
    const { ok: _ok, ...body } = result;
    return NextResponse.json({ success: true, ...body });
  } catch (error) {
    console.error("Subscription confirm error:", error);
    return NextResponse.json(
      { success: false, message: "결제 처리 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
