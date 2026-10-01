import { db } from "@/lib/database";

// A verification mail goes to whatever address the user types, so without a
// limit one account could send naru.pub mail to anyone, as often as it liked.
// Each send replaces the account's token, so the latest token's age says when
// the last mail went out.
export const VERIFICATION_EMAIL_COOLDOWN_MS = 60 * 1000;
export const VERIFICATION_EMAIL_COOLDOWN_MESSAGE =
  "인증 메일은 1분에 한 번만 보낼 수 있습니다. 잠시 후 다시 시도해 주세요.";

export async function verificationEmailSentRecently(
  userId: string,
  now = new Date(),
): Promise<boolean> {
  const recent = await db
    .selectFrom("email_verification_tokens")
    .select("id")
    .where("user_id", "=", userId)
    .where(
      "created_at",
      ">",
      new Date(now.getTime() - VERIFICATION_EMAIL_COOLDOWN_MS),
    )
    .executeTakeFirst();
  return recent != null;
}
