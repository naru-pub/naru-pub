import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { assertJsonContentType } from "@/lib/utils";
import { confirmSubscription } from "@/lib/payments/subscription-signup";
import { parseUuid } from "@/lib/uuid";

// Step 2 of the subscribe flow: exchanges the authKey for a billing key. When
// prepaid access remains, the first charge is scheduled for its expiry;
// otherwise the first period is charged immediately. A card change's callback
// lands here too, and swaps the new key in.
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

    const { authKey, customerKey, registrationId } = await request.json();
    // Absent from callbacks for registrations prepared before they had ids.
    const registration =
      registrationId == null ? null : parseUuid(registrationId);
    if (
      typeof authKey !== "string" ||
      typeof customerKey !== "string" ||
      (registrationId != null && !registration)
    ) {
      return NextResponse.json(
        { success: false, message: "유효하지 않은 요청입니다." },
        { status: 400 },
      );
    }

    const result = await confirmSubscription({
      userId: user.id,
      authKey,
      customerKey,
      registrationId: registration,
    });
    if (!result.ok) {
      return NextResponse.json(
        { success: false, message: result.message },
        { status: result.status },
      );
    }
    const { ok: _ok, ...body } = result;
    return NextResponse.json(
      { success: true, ...body },
      { status: result.chargeQueued ? 202 : 200 },
    );
  } catch (error) {
    console.error("Subscription confirm error:", error);
    return NextResponse.json(
      { success: false, message: "결제 처리 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
