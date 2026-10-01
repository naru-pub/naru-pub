import { NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { prepareCardChange } from "@/lib/subscription-signup";

// Starts registering a new card for an active or scheduled subscription. The
// callback and confirm are the subscribe flow's; the registration id tells
// confirm to swap the key rather than charge a first period.
export async function POST() {
  try {
    const { user } = await validateRequest();
    if (!user) {
      return NextResponse.json(
        { success: false, message: "로그인이 필요합니다." },
        { status: 401 },
      );
    }

    const result = await prepareCardChange({ userId: user.id });
    if (!result.ok) {
      return NextResponse.json(
        { success: false, message: result.message },
        { status: result.status },
      );
    }
    return NextResponse.json({
      success: true,
      customerKey: result.customerKey,
      registrationId: result.registrationId,
    });
  } catch (error) {
    console.error("Card change prepare error:", error);
    return NextResponse.json(
      { success: false, message: "카드 변경 준비 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
