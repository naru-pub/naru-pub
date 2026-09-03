import { db } from "@/lib/database";

// Operators can inspect and reconcile payment records across accounts.
export const PAYMENT_OPERATOR_USERS = new Set(["yang"]);

// Supporting 나루 opens a billing relationship we have to be able to reach the
// supporter about — thank-you receipts, renewal notices, failed charges — so a
// verified email address is a precondition for starting any purchase.
export function hasVerifiedEmail(user: {
  email: string | null;
  emailVerifiedAt: Date | null;
}): boolean {
  return user.email !== null && user.emailVerifiedAt !== null;
}

export const EMAIL_VERIFICATION_REQUIRED_MESSAGE =
  "후원하려면 먼저 이메일 주소를 인증해 주세요.";

// 후원 화면은 광고가 아니라 이미 결제한 사람의 창구다. 결제 내역, 정기 후원
// 취소, 환불 신청이 모두 /support 아래에 있는데 사이트 어디에서도 링크하지
// 않으면, 판매 정책에 적어 둔 "결제 내역에서 직접 신청" 이 주소를 아는
// 사람에게만 열려 있는 셈이 된다. 그래서 결제한 적이 있거나 지금 후원자인
// 계정에만 계정 메뉴에 후원을 띄운다. 후원한 적 없는 방문자에게 후원이 전혀
// 보이지 않는다는 원칙은 그대로다.
//
// 기간이 끝난 계정도 참으로 둔다. 영수증은 후원이 끝난 뒤에 더 필요하다.
export async function hasSupportRelationship(userId: number): Promise<boolean> {
  const row = await db
    .selectFrom("users")
    .select((eb) => [
      "users.supporter_comp",
      "users.supporter_until",
      eb
        .exists(
          eb
            .selectFrom("payments")
            .select("payments.id")
            .whereRef("payments.user_id", "=", "users.id"),
        )
        .as("has_payment"),
    ])
    .where("users.id", "=", userId)
    .executeTakeFirst();

  if (!row) return false;
  return !!(row.supporter_comp || row.supporter_until || row.has_payment);
}
