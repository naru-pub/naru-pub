import { NextRequest, NextResponse } from "next/server";
import {
  VERIFICATION_EMAIL_COOLDOWN_MESSAGE,
  verificationEmailSentRecently,
} from "@/lib/email-verification";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { sendVerificationEmail, generateVerificationToken } from "@/lib/email";
import { assertJsonContentType } from "@/lib/utils";

export async function POST(request: NextRequest) {
  try {
    try {
      assertJsonContentType(request);
    } catch {
      return NextResponse.json(
        { success: false, message: "Invalid content type" },
        { status: 400 }
      );
    }

    const { user } = await validateRequest();
    if (!user) {
      return NextResponse.json(
        { success: false, message: "로그인이 필요합니다." },
        { status: 401 }
      );
    }

    const { email } = await request.json();

    if (!email) {
      return NextResponse.json(
        { success: false, message: "이메일을 입력해주세요." },
        { status: 400 }
      );
    }

    // Check if email is already associated with another user
    const existingUser = await db
      .selectFrom("users")
      .select("id")
      .where("email", "=", email)
      .where("id", "!=", user.id)
      .executeTakeFirst();

    if (existingUser) {
      return NextResponse.json(
        { success: false, message: "이미 다른 계정에서 사용 중인 이메일입니다." },
        { status: 400 }
      );
    }

    if (await verificationEmailSentRecently(user.id)) {
      return NextResponse.json(
        { success: false, message: VERIFICATION_EMAIL_COOLDOWN_MESSAGE },
        { status: 429 }
      );
    }

    // Generate verification token
    const token = generateVerificationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await db.transaction().execute(async (trx) => {
      // Delete any existing verification tokens for this user
      await trx
        .deleteFrom("email_verification_tokens")
        .where("user_id", "=", user.id)
        .execute();

      // Insert new verification token
      await trx
        .insertInto("email_verification_tokens")
        .values({
          id: token,
          user_id: user.id,
          email,
          expires_at: expiresAt,
        })
        .execute();
    });

    // Send verification email
    await sendVerificationEmail(email, token);

    return NextResponse.json({
      success: true,
      message: "인증 이메일이 발송되었습니다. 이메일을 확인해주세요.",
    });
  } catch (error) {
    console.error("Email association error:", error);
    return NextResponse.json(
      { success: false, message: "이메일 연결 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}