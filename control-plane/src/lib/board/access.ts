import { validateRequest, type User } from "@/lib/auth";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import { BoardError } from "./errors";

// The board is moderated by the same operators who run /admin. Nobody else
// can edit or delete someone else's posts and replies.
export function isBoardAdmin(user: Pick<User, "loginName"> | null): boolean {
  return !!user && PAYMENT_OPERATOR_USERS.has(user.loginName);
}

export async function requireUser(): Promise<User> {
  const { user } = await validateRequest();
  if (!user) throw new BoardError(401, "로그인이 필요합니다.");
  return user;
}

// Writing to the board takes a verified email: signing up alone costs a
// spammer nothing.
export async function requireVerifiedUser(): Promise<User> {
  const user = await requireUser();
  if (!user.emailVerifiedAt) {
    throw new BoardError(
      403,
      "게시판에 글을 쓰려면 계정 설정에서 이메일을 인증해 주세요.",
    );
  }
  return user;
}

export function canModerate(
  user: Pick<User, "id" | "loginName"> | null,
  authorId: string,
): boolean {
  return !!user && (user.id === authorId || isBoardAdmin(user));
}
