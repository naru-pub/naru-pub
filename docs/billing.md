# 후원과 결제 (Toss Payments)

후원자 전용 기능은 **시간 기반 엔티틀먼트**로 제어됩니다. 영구 무료 제공 계정은 `users.supporter_comp`, 결제로 얻은 유료 기간은 `users.supporter_until`(유료 기간이 끝나는 시각)로 나타냅니다. 접근 권한 = `supporter_comp OR supporter_until + PAYMENT_GRACE_DAYS > now()`입니다. 즉 `supporter_until`은 유료 기간 경계로 남고, 결제 유예 기간 동안은 후원자 기능도 계속 열려 있습니다.

기능 묶음은 `lib/entitlements.ts`의 `PLAN_FEATURES`에 정의됩니다. 지금은 `supporter → [custom_domains, github_deploys, analytics]`입니다. 새 플랜은 키를 추가해 확장합니다.

후원자 전용 설정은 `/supporters`에서 관리합니다. 결제/후원 흐름은 `/support`에 남겨둡니다.

결제는 **Toss Payments 자동결제(빌링)** 입니다. 월 1,000원 / 연 10,000원.

- **구독 시작**: `subscription/prepare`가 플랜을 `incomplete` 구독으로 기록하고 `customerKey`를 반환 → 프런트가 `requestBillingAuth`로 카드 등록 → `/account/subscription/callback`이 `subscription/confirm` 호출 → 빌링키 발급 후 첫 결제, `subscriptions`를 `active`로, `supporter_until`을 채웁니다. 금액은 항상 서버(`lib/toss.ts`의 `PLAN_AMOUNTS`)에서 결정합니다.
- **자동 갱신**: cron의 `charge-subscriptions.ts`(매일 04:00)가 `next_billing_at`이 지난 활성 구독을 빌링키로 청구해 기간을 연장합니다. 실패 시 결제 유예 기간 안에서 `MAX_PAYMENT_RETRY_ATTEMPTS`까지 재시도합니다. 재시도 한도나 유예 기간 끝에 도달하면 `past_due`로 전환됩니다.
- **자동 대사**: `reconcile-payments.ts`가 5분마다 오래된 `pending` 주문을 Toss에서 조회합니다. 결제가 완료됐으면 결제 원장과 이용 기간을 한 트랜잭션으로 확정하고, 확인되지 않은 주문은 30분 뒤 만료합니다. 사용자는 결제 내역의 “다시 확인”으로 즉시 같은 대사를 요청할 수도 있습니다.
- **이메일 알림**: 후원 시작/한 번만 후원 성공 시 한국어 인디웹 후원 감사 메일을 보냅니다. cron의 `send-billing-notifications.ts`(매일 09:00)가 다음 결제일 3일 이내인 인증된 이메일 계정에 갱신 예정 안내를 보냅니다. `charge-subscriptions.ts`는 갱신 결제 첫 실패 시 결제 유예 기간 안내를 한 번 보냅니다.
- **취소**: `subscription/cancel`은 `status='canceled'`로 두고 `supporter_until`은 유지 → 결제한 기간 동안은 계속 이용 가능.
- **커스텀 도메인 회수**: cron의 `cleanup-expired-custom-domains.ts`(매일 04:30)가 `supporter_until + PAYMENT_GRACE_DAYS`가 지난 비-comp 계정의 Cloudflare for SaaS Custom Hostname을 삭제한 뒤 로컬 `custom_domains` 행을 제거합니다. 이미 Cloudflare에서 삭제된 404는 성공으로 처리합니다.
- **웹훅**: 일반 결제 웹훅에는 서명이 없으므로 payload를 신뢰하지 않습니다. `api/webhooks/toss`는 `orderId`로 Toss API를 다시 조회하고 금액과 상태를 확인한 뒤 원장을 동기화합니다. 성공 결제의 엔티틀먼트 부여는 confirm/cron의 원자적 처리에서만 수행합니다.

## 데이터 모델

- `users.supporter_comp` / `users.supporter_until` / `users.toss_customer_key`
- `subscriptions`: 사용자당 한 행. `plan`, `billing_interval`, `amount`, `status`(`incomplete`/`active`/`past_due`/`canceled`), `toss_billing_key`(서버 전용), 기간 필드.
- `payments`: Toss 청구 시도/성공 원장.

## 환경 변수

- `TOSS_CLIENT_KEY`: 서버에서 읽어 클라이언트로 전달하는 공개 키.
- `TOSS_SECRET_KEY`: 서버 전용 시크릿 키.
- `RESEND_API_KEY` / `FROM_EMAIL` / `BASE_URL`: 결제 갱신/실패 안내 메일 발송에 사용합니다.

개발/테스트에는 Toss 테스트 키를 사용하세요.
