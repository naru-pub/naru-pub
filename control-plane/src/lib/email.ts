import { createMessage } from "@upyo/core";
import { ResendTransport } from "@upyo/resend";
import { generateId } from "./id";

const transport = new ResendTransport({
  apiKey: process.env.RESEND_API_KEY!,
});

// What a payment mail is about, for its payment_mails record.
export type PaymentMailRef = {
  userId?: string | null;
  paymentId?: string | null;
  subscriptionId?: string | null;
};

export type PaymentMailRecord = {
  kind: string;
  recipient: string;
  ref: PaymentMailRef;
  messageId: string | null;
  error: string | null;
};

// Set by lib/payment-mails.ts, which keeps each payment mail in the
// database; email.ts itself stays free of it.
let paymentMailRecorder: ((record: PaymentMailRecord) => Promise<void>) | null =
  null;
export function setPaymentMailRecorder(
  recorder: (record: PaymentMailRecord) => Promise<void>,
) {
  paymentMailRecorder = recorder;
}

async function sendPaymentMail(
  message: Parameters<typeof transport.send>[0],
  kind: string,
  recipient: string,
  ref: PaymentMailRef = {},
) {
  let receipt: Awaited<ReturnType<typeof transport.send>> | null = null;
  try {
    receipt = await transport.send(message);
    return receipt;
  } finally {
    await paymentMailRecorder?.({
      kind,
      recipient,
      ref,
      messageId: receipt?.successful ? receipt.messageId : null,
      error: !receipt
        ? "send threw"
        : receipt.successful
          ? null
          : (receipt.errorMessages?.join(", ") ?? "send failed"),
    });
  }
}

// `next` is a page to continue to once verified (safeNextPath): /support when
// the mail was asked for from the purchase page.
export async function sendVerificationEmail(
  email: string,
  token: string,
  next?: string | null,
) {
  const params = new URLSearchParams({ token });
  if (next) params.set("next", next);
  const verificationUrl = `${process.env.BASE_URL}/verify-email?${params}`;

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
  // What the mail is about, for the payment_mails record.
  ref?: PaymentMailRef;
  email: string;
  loginName: string;
  amount: number;
  nextBillingAt: Date;
}) {
  // Card change, cancel and re-subscribe live on /support, not /account.
  const accountUrl = `${process.env.BASE_URL}/support`;
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
          <p>원치 않으시면 결제 예정일 전에 결제 페이지에서 정기 결제를 해지할 수 있습니다.</p>
        </div>
      `,
      text: `
        나루 결제 갱신 안내

        ${opts.loginName}님, 나루 결제가 곧 자동 갱신됩니다.

        결제 예정일: ${nextBillingLabel}
        결제 예정 금액: ${amountLabel}

        결제를 계속 유지하면 커스텀 도메인 같은 유료 기능을 계속 이용하실 수 있습니다.
        원치 않으시면 결제 예정일 전에 결제 페이지에서 정기 결제를 해지할 수 있습니다.

        결제 관리: ${accountUrl}
      `,
    },
    tags: ["billing", "subscription-renewal"],
  });

  const receipt = await sendPaymentMail(
    message,
    "renewal_notice",
    opts.email,
    opts.ref,
  );
  if (!receipt.successful) {
    throw new Error(
      `Failed to send subscription renewal notice email: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}

export async function sendSubscriptionPaymentGraceEmail(opts: {
  // What the mail is about, for the payment_mails record.
  ref?: PaymentMailRef;
  email: string;
  loginName: string;
  amount: number;
  graceEndsAt: Date;
}) {
  // Card change, cancel and re-subscribe live on /support, not /account.
  const accountUrl = `${process.env.BASE_URL}/support`;
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

  const receipt = await sendPaymentMail(
    message,
    "grace_notice",
    opts.email,
    opts.ref,
  );
  if (!receipt.successful) {
    throw new Error(
      `Failed to send subscription payment grace email: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}

export async function sendSupportThankYouEmail(opts: {
  // What the mail is about, for the payment_mails record.
  ref?: PaymentMailRef;
  email: string;
  loginName: string;
  kind: "recurring" | "one_time";
  amount: number;
  supporterUntil: Date;
}) {
  // Card change, cancel and re-subscribe live on /support, not /account.
  const accountUrl = `${process.env.BASE_URL}/support`;
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
          <p>결제 내역과 정기 결제는 결제 페이지에서 확인하실 수 있습니다.</p>
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

        결제 내역과 정기 결제는 결제 페이지에서 확인하실 수 있습니다.
        ${accountUrl}
      `,
    },
    tags: ["billing", "support-thank-you"],
  });

  const receipt = await sendPaymentMail(
    message,
    "thank_you",
    opts.email,
    opts.ref,
  );
  if (!receipt.successful) {
    throw new Error(
      `Failed to send support thank you email: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}

// Sent for every recurring charge after the first — the renewals and a
// scheduled first charge, which the cron makes while nobody is watching. The
// supporter's only other sign of it would be the card statement.
export async function sendRecurringChargeReceiptEmail(opts: {
  // What the mail is about, for the payment_mails record.
  ref?: PaymentMailRef;
  email: string;
  loginName: string;
  amount: number;
  orderId: string;
  paidAt: Date;
  periodStart: Date;
  periodEnd: Date;
  nextBillingAt: Date | null;
  receiptUrl: string | null;
}) {
  const paymentsUrl = `${process.env.BASE_URL}/support/payments`;
  const amountLabel = formatKrw(opts.amount);
  const paidAtLabel = formatKoreanDateTime(opts.paidAt);
  const periodLabel = `${formatKoreanDateTime(opts.periodStart)} ~ ${formatKoreanDateTime(opts.periodEnd)}`;
  const nextLabel = opts.nextBillingAt
    ? formatKoreanDateTime(opts.nextBillingAt)
    : null;

  const message = createMessage({
    from: process.env.FROM_EMAIL || "noreply@naru.pub",
    to: opts.email,
    subject: "나루 정기 결제가 완료되었습니다",
    content: {
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>나루 정기 결제 완료 안내</h2>
          <p>${escapeHtml(opts.loginName)}님, 나루 정기 결제가 처리되었습니다. 늘 함께해 주셔서 감사합니다.</p>
          <p><strong>결제 금액:</strong> ${amountLabel}</p>
          <p><strong>결제 일시:</strong> ${paidAtLabel}</p>
          <p><strong>주문번호:</strong> ${escapeHtml(opts.orderId)}</p>
          <p><strong>이용 기간:</strong> ${periodLabel}</p>
          ${nextLabel ? `<p><strong>다음 결제 예정일:</strong> ${nextLabel}</p>` : ""}
          ${opts.receiptUrl ? `<p><a href="${escapeHtml(opts.receiptUrl)}">카드 매출전표 보기</a></p>` : ""}
          <p>결제 내역 확인, 정기 결제 해지, 환불 신청은 결제 페이지에서 언제든 하실 수 있습니다.</p>
          <p>
            <a href="${paymentsUrl}" style="background-color: #007cba; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              결제 내역 보기
            </a>
          </p>
        </div>
      `,
      text: [
        "나루 정기 결제 완료 안내",
        "",
        `${opts.loginName}님, 나루 정기 결제가 처리되었습니다. 늘 함께해 주셔서 감사합니다.`,
        "",
        `결제 금액: ${amountLabel}`,
        `결제 일시: ${paidAtLabel}`,
        `주문번호: ${opts.orderId}`,
        `이용 기간: ${periodLabel}`,
        ...(nextLabel ? [`다음 결제 예정일: ${nextLabel}`] : []),
        ...(opts.receiptUrl ? [`카드 매출전표: ${opts.receiptUrl}`] : []),
        "",
        "결제 내역 확인, 정기 결제 해지, 환불 신청은 결제 페이지에서 언제든 하실 수 있습니다.",
        paymentsUrl,
      ].join("\n"),
    },
    tags: ["billing", "recurring-receipt"],
  });

  const receipt = await sendPaymentMail(
    message,
    "charge_receipt",
    opts.email,
    opts.ref,
  );
  if (!receipt.successful) {
    throw new Error(
      `Failed to send recurring charge receipt email: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}

// Sent the first time 나루 sees a payment refunded, however it was refunded:
// the supporter's own request, an operator, the Toss dashboard or a card
// dispute. Toss calls a refund a cancel (결제 취소), and so does the card
// statement, so the mail does too.
export async function sendPaymentCanceledEmail(opts: {
  // What the mail is about, for the payment_mails record.
  ref?: PaymentMailRef;
  email: string;
  loginName: string;
  amount: number;
  refundedAmount: number;
  orderId: string;
  refundedAt: Date;
  // Where paid access now ends; null when it has ended.
  supporterUntil: Date | null;
  // Whether this refund also stopped recurring billing.
  subscriptionCanceled: boolean;
}) {
  const paymentsUrl = `${process.env.BASE_URL}/support/payments`;
  const amountLabel = formatKrw(opts.amount);
  const refundedLabel = formatKrw(opts.refundedAmount);
  const refundedAtLabel = formatKoreanDateTime(opts.refundedAt);
  const accessLine = opts.supporterUntil
    ? `유료 기능은 ${formatKoreanDateTime(opts.supporterUntil)}까지 이용하실 수 있습니다.`
    : "취소된 결제로 이용하시던 유료 기능은 종료되었습니다.";
  const subscriptionLine = opts.subscriptionCanceled
    ? "정기 결제도 함께 해지되어 더 이상 결제되지 않습니다."
    : null;
  const cardLine =
    "카드 결제 취소는 카드사에 따라 반영까지 영업일 기준 3~7일이 걸릴 수 있습니다.";

  const message = createMessage({
    from: process.env.FROM_EMAIL || "noreply@naru.pub",
    to: opts.email,
    subject: "나루 결제가 취소되었습니다",
    content: {
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>나루 결제 취소 안내</h2>
          <p>${escapeHtml(opts.loginName)}님, 나루 결제가 취소되어 환불되었습니다.</p>
          <p><strong>환불 금액:</strong> ${refundedLabel}${opts.refundedAmount < opts.amount ? ` (결제 금액 ${amountLabel} 중)` : ""}</p>
          <p><strong>취소 일시:</strong> ${refundedAtLabel}</p>
          <p><strong>주문번호:</strong> ${escapeHtml(opts.orderId)}</p>
          <p>${accessLine}</p>
          ${subscriptionLine ? `<p>${subscriptionLine}</p>` : ""}
          <p>${cardLine}</p>
          <p>
            <a href="${paymentsUrl}" style="background-color: #007cba; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              결제 내역 보기
            </a>
          </p>
        </div>
      `,
      text: [
        "나루 결제 취소 안내",
        "",
        `${opts.loginName}님, 나루 결제가 취소되어 환불되었습니다.`,
        "",
        `환불 금액: ${refundedLabel}${opts.refundedAmount < opts.amount ? ` (결제 금액 ${amountLabel} 중)` : ""}`,
        `취소 일시: ${refundedAtLabel}`,
        `주문번호: ${opts.orderId}`,
        "",
        accessLine,
        ...(subscriptionLine ? [subscriptionLine] : []),
        cardLine,
        "",
        `결제 내역: ${paymentsUrl}`,
      ].join("\n"),
    },
    tags: ["billing", "payment-canceled"],
  });

  const receipt = await sendPaymentMail(
    message,
    "payment_canceled",
    opts.email,
    opts.ref,
  );
  if (!receipt.successful) {
    throw new Error(
      `Failed to send payment canceled email: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}

export type SubscriptionCancelReason =
  // The supporter canceled an active (or past due) plan.
  | "user"
  // The supporter called off a plan whose first charge was still scheduled.
  | "user_schedule"
  // A refund stopped it.
  | "refund"
  // The card's billing key was deleted at Toss (BILLING_DELETED).
  | "billing_key_deleted";

// Sent when recurring billing stops, so the supporter has it in writing that
// the card will not be charged again. A refund that stops it says so in its
// own cancel mail instead; this covers the refunds whose stop that mail
// cannot report (see stopRecurringBilling in lib/refunds.ts).
export async function sendSubscriptionCanceledEmail(opts: {
  // What the mail is about, for the payment_mails record.
  ref?: PaymentMailRef;
  email: string;
  loginName: string;
  reason: SubscriptionCancelReason;
  canceledAt: Date;
  // Where paid access ends; null when there is none left.
  supporterUntil: Date | null;
}) {
  const paymentsUrl = `${process.env.BASE_URL}/support/payments`;
  const canceledAtLabel = formatKoreanDateTime(opts.canceledAt);
  const scheduled = opts.reason === "user_schedule";
  const title = scheduled
    ? "나루 정기 결제 예약 취소 안내"
    : "나루 정기 결제 해지 안내";
  const intro = {
    user: "요청하신 대로 나루 정기 결제가 해지되었습니다.",
    user_schedule:
      "요청하신 대로 예약된 나루 정기 결제가 취소되었습니다. 첫 결제는 이루어지지 않습니다.",
    refund: "결제 환불에 따라 나루 정기 결제가 해지되었습니다.",
    billing_key_deleted:
      "등록된 결제 카드가 결제사에서 삭제되어 나루 정기 결제가 해지되었습니다.",
  }[opts.reason];
  const accessLine = opts.supporterUntil
    ? `이미 결제하신 기간이 끝나는 ${formatKoreanDateTime(opts.supporterUntil)}까지는 유료 기능을 계속 이용하실 수 있습니다.`
    : null;
  const closing =
    "앞으로 등록된 카드로 결제되지 않습니다. 언제든 다시 결제하실 수 있습니다.";

  const message = createMessage({
    from: process.env.FROM_EMAIL || "noreply@naru.pub",
    to: opts.email,
    subject: scheduled
      ? "나루 정기 결제 예약이 취소되었습니다"
      : "나루 정기 결제가 해지되었습니다",
    content: {
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>${title}</h2>
          <p>${escapeHtml(opts.loginName)}님, ${intro}</p>
          <p><strong>해지 일시:</strong> ${canceledAtLabel}</p>
          ${accessLine ? `<p>${accessLine}</p>` : ""}
          <p>${closing}</p>
          <p>
            <a href="${paymentsUrl}" style="background-color: #007cba; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              결제 내역 보기
            </a>
          </p>
        </div>
      `,
      text: [
        title,
        "",
        `${opts.loginName}님, ${intro}`,
        "",
        `해지 일시: ${canceledAtLabel}`,
        ...(accessLine ? [accessLine] : []),
        closing,
        "",
        `결제 내역: ${paymentsUrl}`,
      ].join("\n"),
    },
    tags: ["billing", "subscription-canceled"],
  });

  const receipt = await sendPaymentMail(
    message,
    "subscription_canceled",
    opts.email,
    opts.ref,
  );
  if (!receipt.successful) {
    throw new Error(
      `Failed to send subscription canceled email: ${receipt.errorMessages?.join(", ")}`,
    );
  }
  return receipt;
}

export type SubscriptionPastDueReason =
  // The card was declined until the retries or the grace period ran out.
  | "declined"
  // The grace period ran out while Toss had not said whether the renewal
  // went through.
  | "unresolved";

// Sent when a recurring plan stops renewing because its charge could not be
// made: the grace notice promised a deadline, and this is what happened at
// it. Paid access follows supporter_until and the grace window, not the
// plan's status, so it may still run for a few days.
export async function sendSubscriptionPastDueEmail(opts: {
  // What the mail is about, for the payment_mails record.
  ref?: PaymentMailRef;
  email: string;
  loginName: string;
  amount: number;
  reason: SubscriptionPastDueReason;
  // How many tries the card declined. One when the grace period had already
  // ended at the first decline, so "tried several times" would be untrue.
  declinedAttempts?: number;
  // When paid features end; null when they already have. Omitted (undefined)
  // when no date applies, as for a comp.
  accessEndsAt: Date | null | undefined;
}) {
  // Card change, cancel and re-subscribe live on /support, not /account.
  const accountUrl = `${process.env.BASE_URL}/support`;
  const amountLabel = formatKrw(opts.amount);
  const intro =
    opts.reason === "declined"
      ? (opts.declinedAttempts ?? 2) > 1
        ? `나루 정기 결제(${amountLabel})를 여러 번 시도했지만 등록된 카드로 결제하지 못해 정기 결제를 멈췄습니다. 더 이상 자동으로 결제를 시도하지 않습니다.`
        : `나루 정기 결제(${amountLabel})를 등록된 카드로 결제하지 못했고 결제 유예 기간도 이미 끝나 정기 결제를 멈췄습니다. 더 이상 자동으로 결제를 시도하지 않습니다.`
      : `나루 정기 결제(${amountLabel})의 결과를 결제사에서 확인하지 못한 채 유예 기간이 끝나 정기 결제를 멈췄습니다. 결제가 된 것으로 확인되면 자동으로 다시 이어지고 영수증을 보내드립니다.`;
  const accessLine =
    opts.accessEndsAt === undefined
      ? null
      : opts.accessEndsAt
        ? `유료 기능은 ${formatKoreanDateTime(opts.accessEndsAt)}까지 유지됩니다. 그 전에 다시 결제하시면 끊기지 않고 이어집니다.`
        : "커스텀 도메인 같은 유료 기능은 중단되었고, 연결된 커스텀 도메인은 해제될 수 있습니다.";
  const closing =
    "결제 페이지에서 카드를 다시 등록하면 정기 결제를 다시 시작할 수 있습니다.";

  const message = createMessage({
    from: process.env.FROM_EMAIL || "noreply@naru.pub",
    to: opts.email,
    subject: "나루 정기 결제가 중단되었습니다",
    content: {
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>나루 정기 결제 중단 안내</h2>
          <p>${escapeHtml(opts.loginName)}님, ${intro}</p>
          ${accessLine ? `<p>${accessLine}</p>` : ""}
          <p>${closing}</p>
          <p>
            <a href="${accountUrl}" style="background-color: #d97706; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              다시 결제하기
            </a>
          </p>
        </div>
      `,
      text: [
        "나루 정기 결제 중단 안내",
        "",
        `${opts.loginName}님, ${intro}`,
        "",
        ...(accessLine ? [accessLine] : []),
        closing,
        "",
        `다시 결제하기: ${accountUrl}`,
      ].join("\n"),
    },
    tags: ["billing", "subscription-past-due"],
  });

  const receipt = await sendPaymentMail(
    message,
    "past_due_notice",
    opts.email,
    opts.ref,
  );
  if (!receipt.successful) {
    throw new Error(
      `Failed to send subscription past due email: ${receipt.errorMessages?.join(", ")}`,
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
