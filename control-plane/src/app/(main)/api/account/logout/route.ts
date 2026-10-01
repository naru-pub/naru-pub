import { NextRequest, NextResponse } from "next/server";
import { assertSameOriginRequest } from "@/lib/utils";
import { deleteSessionCookie, invalidateSession, validateRequest } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    try {
      assertSameOriginRequest(request);
    } catch {
      return NextResponse.json(
        { success: false, message: "잘못된 요청입니다." },
        { status: 400 },
      );
    }

    const { session } = await validateRequest();
    if (!session) {
      return NextResponse.json(
        { success: false, message: "로그인이 필요합니다." },
        { status: 401 }
      );
    }

    await invalidateSession(session.id);
    await deleteSessionCookie();

    return NextResponse.json({
      success: true,
      message: "로그아웃되었습니다.",
    });
  } catch (error) {
    console.error("Logout error:", error);
    return NextResponse.json(
      { success: false, message: "로그아웃 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}