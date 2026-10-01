import { createMessage } from "@upyo/core";
import { ResendTransport } from "@upyo/resend";
import { generateId } from "./id";

const transport = new ResendTransport({
  apiKey: process.env.RESEND_API_KEY!,
});

export async function sendVerificationEmail(email: string, token: string) {
  const verificationUrl = `${process.env.BASE_URL}/verify-email?token=${token}`;

  const message = createMessage({
    from: process.env.FROM_EMAIL || "noreply@naru.pub",
    to: email,
    subject: "이메일 주소를 인증해주세요",
    content: {
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>이메일 주소 인증</h2>
          <p>아래 링크를 클릭하여 이메일 주소를 인증해주세요:</p>
          <p>
            <a href="${verificationUrl}" style="background-color: #007cba; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              이메일 인증하기
            </a>
          </p>
          <p>이메일 인증을 요청하지 않았다면 이 이메일을 무시하셔도 됩니다.</p>
          <p>이 링크는 24시간 후에 만료됩니다.</p>
        </div>
      `,
      text: `
        이메일 주소 인증
        
        다음 링크를 방문하여 이메일 주소를 인증해주세요:
        ${verificationUrl}
        
        이메일 인증을 요청하지 않았다면 이 이메일을 무시하셔도 됩니다.
        이 링크는 24시간 후에 만료됩니다.
      `,
    },
    tags: ["verification", "onboarding"],
  });

  const receipt = await transport.send(message);
  if (!receipt.successful) {
    throw new Error(
      `Failed to send verification email: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}

export async function sendPasswordResetEmail(email: string, token: string) {
  const resetUrl = `${process.env.BASE_URL}/reset-password?token=${token}`;

  const message = createMessage({
    from: process.env.FROM_EMAIL || "noreply@naru.pub",
    to: email,
    subject: "비밀번호 재설정",
    content: {
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>비밀번호 재설정</h2>
          <p>아래 링크를 클릭하여 새로운 비밀번호를 설정해주세요:</p>
          <p>
            <a href="${resetUrl}" style="background-color: #007cba; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              비밀번호 재설정하기
            </a>
          </p>
          <p>비밀번호 재설정을 요청하지 않았다면 이 이메일을 무시하셔도 됩니다.</p>
          <p>이 링크는 1시간 후에 만료됩니다.</p>
        </div>
      `,
      text: `
        비밀번호 재설정
        
        다음 링크를 방문하여 새로운 비밀번호를 설정해주세요:
        ${resetUrl}
        
        비밀번호 재설정을 요청하지 않았다면 이 이메일을 무시하셔도 됩니다.
        이 링크는 1시간 후에 만료됩니다.
      `,
    },
    tags: ["password-reset", "security"],
  });

  const receipt = await transport.send(message);
  if (!receipt.successful) {
    throw new Error(
      `Failed to send password reset email: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}

export function generateVerificationToken(): string {
  return generateId(32);
}

export function generatePasswordResetToken(): string {
  return generateId(32);
}

export async function sendAccountDeletionEmail(email: string, token: string) {
  const confirmationUrl = `${process.env.BASE_URL}/confirm-account-deletion?token=${token}`;

  const message = createMessage({
    from: process.env.FROM_EMAIL || "noreply@naru.pub",
    to: email,
    subject: "계정 삭제 확인",
    content: {
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #d32f2f;">계정 삭제 확인</h2>
          <p><strong>주의:</strong> 계정 삭제를 완료하려면 아래 링크를 클릭해주세요.</p>
          <p>계정이 삭제되면:</p>
          <ul>
            <li>모든 파일과 데이터가 영구적으로 삭제됩니다</li>
            <li>이 작업은 되돌릴 수 없습니다</li>
            <li>동일한 로그인명으로 다시 가입할 수 있습니다</li>
          </ul>
          <p>
            <a href="${confirmationUrl}" style="background-color: #d32f2f; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              계정 삭제 확인
            </a>
          </p>
          <p>계정 삭제를 요청하지 않았다면 이 이메일을 무시하셔도 됩니다.</p>
          <p>이 링크는 1시간 후에 만료됩니다.</p>
        </div>
      `,
      text: `
        계정 삭제 확인
        
        주의: 계정 삭제를 완료하려면 다음 링크를 방문해주세요:
        ${confirmationUrl}
        
        계정이 삭제되면:
        - 모든 파일과 데이터가 영구적으로 삭제됩니다
        - 이 작업은 되돌릴 수 없습니다
        - 동일한 로그인명으로 다시 가입할 수 있습니다
        
        계정 삭제를 요청하지 않았다면 이 이메일을 무시하셔도 됩니다.
        이 링크는 1시간 후에 만료됩니다.
      `,
    },
    tags: ["account-deletion", "security"],
  });

  const receipt = await transport.send(message);
  if (!receipt.successful) {
    throw new Error(
      `Failed to send account deletion email: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}

export function generateAccountDeletionToken(): string {
  return generateId(32);
}

export async function sendExportReadyEmail(
  email: string,
  downloadUrl: string,
  loginName: string,
) {
  const message = createMessage({
    from: process.env.FROM_EMAIL || "noreply@naru.pub",
    to: email,
    subject: "갠홈 내보내기가 완료되었습니다",
    content: {
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>갠홈 내보내기 완료</h2>
          <p>${loginName}님의 갠홈 내보내기 파일이 준비되었습니다.</p>
          <p>
            <a href="${downloadUrl}" style="background-color: #007cba; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              다운로드
            </a>
          </p>
          <p>이 링크는 72시간 후에 만료됩니다.</p>
        </div>
      `,
      text: `
        갠홈 내보내기 완료

        ${loginName}님의 갠홈 내보내기 파일이 준비되었습니다.

        다운로드 링크: ${downloadUrl}

        이 링크는 72시간 후에 만료됩니다.
      `,
    },
    tags: ["export", "home-directory"],
  });

  const receipt = await transport.send(message);
  if (!receipt.successful) {
    throw new Error(
      `Failed to send export ready email: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}

function formatKoreanDateTime(date: Date) {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function formatKrw(amount: number) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0,
  }).format(amount);
}

export async function sendSubscriptionRenewalNoticeEmail(opts: {
  email: string;
  loginName: string;
  amount: number;
  nextBillingAt: Date;
}) {
  const accountUrl = `${process.env.BASE_URL}/account`;
  const nextBillingLabel = formatKoreanDateTime(opts.nextBillingAt);
  const amountLabel = formatKrw(opts.amount);

  const message = createMessage({
    from: process.env.FROM_EMAIL || "noreply@naru.pub",
    to: opts.email,
    subject: "나루 결제가 곧 갱신됩니다",
    content: {
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>나루 결제 갱신 안내</h2>
          <p>${opts.loginName}님, 나루 결제가 곧 자동 갱신됩니다.</p>
          <p><strong>결제 예정일:</strong> ${nextBillingLabel}</p>
          <p><strong>결제 예정 금액:</strong> ${amountLabel}</p>
          <p>결제를 계속 유지하면 커스텀 도메인 같은 유료 기능을 계속 이용하실 수 있습니다.</p>
          <p>
            <a href="${accountUrl}" style="background-color: #007cba; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              계정에서 결제 관리
            </a>
          </p>
          <p>원치 않으시면 결제 예정일 전에 계정 페이지에서 결제를 취소할 수 있습니다.</p>
        </div>
      `,
      text: `
        나루 결제 갱신 안내

        ${opts.loginName}님, 나루 결제가 곧 자동 갱신됩니다.

        결제 예정일: ${nextBillingLabel}
        결제 예정 금액: ${amountLabel}

        결제를 계속 유지하면 커스텀 도메인 같은 유료 기능을 계속 이용하실 수 있습니다.
        원치 않으시면 결제 예정일 전에 계정 페이지에서 결제를 취소할 수 있습니다.

        결제 관리: ${accountUrl}
      `,
    },
    tags: ["billing", "subscription-renewal"],
  });

  const receipt = await transport.send(message);
  if (!receipt.successful) {
    throw new Error(
      `Failed to send subscription renewal notice email: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}

export async function sendSubscriptionPaymentGraceEmail(opts: {
  email: string;
  loginName: string;
  amount: number;
  graceEndsAt: Date;
}) {
  const accountUrl = `${process.env.BASE_URL}/account`;
  const graceEndsLabel = formatKoreanDateTime(opts.graceEndsAt);
  const amountLabel = formatKrw(opts.amount);

  const message = createMessage({
    from: process.env.FROM_EMAIL || "noreply@naru.pub",
    to: opts.email,
    subject: "나루 정기 결제에 실패했습니다",
    content: {
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>나루 정기 결제 실패 안내</h2>
          <p>${opts.loginName}님, 나루 결제 갱신 결제를 처리하지 못했습니다.</p>
          <p><strong>결제 금액:</strong> ${amountLabel}</p>
          <p><strong>유료 기능 유지 기한:</strong> ${graceEndsLabel}</p>
          <p>유예 기간 동안 커스텀 도메인 같은 유료 기능은 계속 유지됩니다. 기한 전까지 결제 수단을 다시 등록하거나 결제를 완료하지 못하면 유료 기능이 중단되고 커스텀 도메인이 해제될 수 있습니다.</p>
          <p>
            <a href="${accountUrl}" style="background-color: #d97706; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              결제 수단 다시 등록
            </a>
          </p>
        </div>
      `,
      text: `
        나루 정기 결제 실패 안내

        ${opts.loginName}님, 나루 결제 갱신 결제를 처리하지 못했습니다.

        결제 금액: ${amountLabel}
        유료 기능 유지 기한: ${graceEndsLabel}

        유예 기간 동안 커스텀 도메인 같은 유료 기능은 계속 유지됩니다.
        기한 전까지 결제 수단을 다시 등록하거나 결제를 완료하지 못하면 유료 기능이 중단되고 커스텀 도메인이 해제될 수 있습니다.

        결제 수단 다시 등록: ${accountUrl}
      `,
    },
    tags: ["billing", "payment-grace"],
  });

  const receipt = await transport.send(message);
  if (!receipt.successful) {
    throw new Error(
      `Failed to send subscription payment grace email: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}

export async function sendSupportThankYouEmail(opts: {
  email: string;
  loginName: string;
  kind: "recurring" | "one_time";
  amount: number;
  supporterUntil: Date;
}) {
  const accountUrl = `${process.env.BASE_URL}/account`;
  const supporterUntilLabel = formatKoreanDateTime(opts.supporterUntil);
  const amountLabel = formatKrw(opts.amount);
  const kindLabel = opts.kind === "recurring" ? "정기 결제" : "한 번만 결제";

  const message = createMessage({
    from: process.env.FROM_EMAIL || "noreply@naru.pub",
    to: opts.email,
    subject: "나루를 결제해 주셔서 감사합니다",
    content: {
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>나루를 결제해 주셔서 감사합니다</h2>
          <p>${opts.loginName}님, ${kindLabel}으로 나루를 결제해 주셔서 진심으로 감사합니다.</p>
          <p>결제해 주신 금액은 한국어 인디웹을 더 오래, 더 안정적으로 이어 가는 데 사용됩니다.</p>
          <p><strong>결제 금액:</strong> ${amountLabel}</p>
          <p><strong>유료 기능 이용 기한:</strong> ${supporterUntilLabel}</p>
          <p>유료 기능과 결제 정보는 계정 페이지에서 확인하실 수 있습니다.</p>
          <p>
            <a href="${accountUrl}" style="background-color: #007cba; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              계정에서 확인하기
            </a>
          </p>
        </div>
      `,
      text: `
        나루를 결제해 주셔서 감사합니다

        ${opts.loginName}님, ${kindLabel}으로 나루를 결제해 주셔서 진심으로 감사합니다.

        결제해 주신 금액은 한국어 인디웹을 더 오래, 더 안정적으로 이어 가는 데 사용됩니다.

        결제 금액: ${amountLabel}
        유료 기능 이용 기한: ${supporterUntilLabel}

        유료 기능과 결제 정보는 계정 페이지에서 확인하실 수 있습니다.
        ${accountUrl}
      `,
    },
    tags: ["billing", "support-thank-you"],
  });

  const receipt = await transport.send(message);
  if (!receipt.successful) {
    throw new Error(
      `Failed to send support thank you email: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Payment and billing events for the operators, several to a message
// (lib/payment-events.ts decides what goes together).
export async function sendPaymentEventDigestEmail(opts: {
  to: string;
  subject: string;
  events: Array<{
    createdAt: Date;
    loginName: string | null;
    kind: string;
    summary: string;
  }>;
}) {
  const adminUrl = `${process.env.BASE_URL}/admin`;
  const rows = opts.events.map((event) => ({
    when: formatKoreanDateTime(event.createdAt),
    who: event.loginName ?? "(삭제된 계정)",
    kind: event.kind,
    summary: event.summary,
  }));

  const message = createMessage({
    from: process.env.FROM_EMAIL || "noreply@naru.pub",
    to: opts.to,
    subject: opts.subject,
    content: {
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 760px; margin: 0 auto;">
          <h2>${escapeHtml(opts.subject)}</h2>
          <table style="border-collapse: collapse; width: 100%; font-size: 14px;">
            <tr style="text-align: left; border-bottom: 1px solid #ccc;">
              <th style="padding: 4px 8px;">시각</th>
              <th style="padding: 4px 8px;">계정</th>
              <th style="padding: 4px 8px;">이벤트</th>
              <th style="padding: 4px 8px;">내용</th>
            </tr>
            ${rows
              .map(
                (row) => `
            <tr style="border-bottom: 1px solid #eee; vertical-align: top;">
              <td style="padding: 4px 8px; white-space: nowrap;">${escapeHtml(row.when)}</td>
              <td style="padding: 4px 8px;">${escapeHtml(row.who)}</td>
              <td style="padding: 4px 8px; white-space: nowrap;">${escapeHtml(row.kind)}</td>
              <td style="padding: 4px 8px;">${escapeHtml(row.summary)}</td>
            </tr>`,
              )
              .join("")}
          </table>
          <p><a href="${adminUrl}">결제 운영 페이지에서 보기</a></p>
        </div>
      `,
      text: [
        opts.subject,
        "",
        ...rows.map(
          (row) => `${row.when}  ${row.who}  [${row.kind}]  ${row.summary}`,
        ),
        "",
        adminUrl,
      ].join("\n"),
    },
    tags: ["billing", "operator-digest"],
  });

  const receipt = await transport.send(message);
  if (!receipt.successful) {
    throw new Error(
      `Failed to send payment event digest: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}
