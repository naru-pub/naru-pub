# 후원과 결제 (Toss Payments)

후원자 전용 기능은 **시간 기반 엔티틀먼트**로 제어됩니다. 영구 무료 제공 계정은 `users.supporter_comp`, 결제로 얻은 유료 기간은 `users.supporter_until`(유료 기간이 끝나는 시각)로 나타냅니다. 접근 권한 = `supporter_comp OR supporter_until + PAYMENT_GRACE_DAYS > now()`입니다. 즉 `supporter_until`은 유료 기간 경계로 남고, 결제 유예 기간 동안은 후원자 기능도 계속 열려 있습니다.

기능 묶음은 `lib/entitlements.ts`의 `PLAN_FEATURES`에 정의됩니다. 지금은 `supporter → [custom_domains, github_deploys, analytics]`입니다. 새 플랜은 키를 추가해 확장합니다.

후원자 전용 설정은 `/domains`(커스텀 도메인)과 `/deploys`(GitHub 배포)에서 관리합니다. 결제/후원 흐름은 `/support`에 남겨둡니다. `/support`는 광고하지 않습니다 — 후원한 적 없는 방문자에게는 어디에도 보이지 않고, 카드사 심사관은 주소를 직접 받습니다. 다만 결제한 적이 있거나 지금 후원자인 계정에는 계정 메뉴에 '후원'이 뜹니다(`hasSupportRelationship`). 결제 내역·정기 후원 취소·환불 신청이 모두 그 아래에 있어서, 링크가 없으면 판매 정책에 적어 둔 환불 창구가 주소를 아는 사람에게만 열립니다.

결제는 **Toss Payments 자동결제(빌링)** 입니다. 월 1,000원 / 연 10,000원.

- **이메일 인증 선행**: 후원을 시작하려면 인증된 이메일 주소가 있어야 합니다. `subscription/prepare`와 `donation/one-time/prepare`는 `users.email`과 `users.email_verified_at`이 모두 채워져 있지 않으면 403을 반환하고, `/support`의 후원 카드도 결제 버튼 대신 인증 안내와 인증 메일 재발송 버튼을 보여줍니다. 영수증, 갱신 예정 안내, 결제 실패 안내를 반드시 전달할 수 있어야 하기 때문입니다.
- **구독 시작**: `subscription/prepare`가 플랜을 `incomplete` 구독으로 기록하고 `customerKey`를 반환 → 프런트가 `requestBillingAuth`로 카드 등록 → `/account/subscription/callback`이 `subscription/confirm` 호출 → 빌링키 발급 후 첫 결제, `subscriptions`를 `active`로, `supporter_until`을 채웁니다. 금액은 항상 서버(`lib/toss.ts`의 `PLAN_AMOUNTS`)에서 결정합니다.
- **자동 갱신**: cron의 `charge-subscriptions.ts`(매일 04:00)가 `next_billing_at`이 지난 활성 구독을 빌링키로 청구해 기간을 연장합니다. 실패 시 결제 유예 기간 안에서 `MAX_PAYMENT_RETRY_ATTEMPTS`까지 재시도합니다. 재시도 한도나 유예 기간 끝에 도달하면 `past_due`로 전환됩니다.
- **자동 대사**: `reconcile-payments.ts`가 5분마다 오래된 `pending` 주문을 Toss에서 조회합니다. 결제가 완료됐으면 결제 원장과 이용 기간을 한 트랜잭션으로 확정하고, 확인되지 않은 주문은 30분 뒤 만료합니다. 사용자는 결제 내역의 “다시 확인”으로 즉시 같은 대사를 요청할 수도 있습니다.
- **환불 신청**: 후원자는 `/support/payments`의 '환불 신청'으로 직접 환불합니다. `api/account/payments/[id]/refund`가 `lib/refunds.ts`의 `refundEligibility`로 판매 정책의 조건 — 결제일로부터 `REFUND_WINDOW_DAYS`(7일) 이내이고, 결제 후 `REFUND_BLOCKING_FEATURES`(커스텀 도메인·GitHub 배포·데이터베이스)를 쓰지 않았을 것 — 을 확인한 뒤 Toss 결제를 취소하고 곧바로 대사합니다. 조건에 맞지 않으면 그 사유(기간 경과·기능 사용·이미 환불됨)를 그대로 돌려주므로 메일로 다시 물을 일이 없습니다. `PAYMENT_OPERATOR_USERS`는 같은 엔드포인트를 `/admin`에서 호출하며, 장애 보상처럼 정책 밖의 환불도 기간·사용 여부와 관계없이 실행할 수 있습니다. 환불이 처리되면 해당 계정의 정기 후원도 함께 취소하고 빌링키를 지워 다시 청구되지 않게 합니다.
- **후원자 기능 사용 기록**: `supporter_feature_uses`(계정×기능당 한 행, `first_used_at`/`last_used_at`)가 후원자 전용 기능이 실제로 쓰였는지를 기록합니다. `lib/feature-usage.ts`의 `noteSupporterFeatureUse`를 방문자 현황 조회, 커스텀 도메인 등록, GitHub 배포 대상 저장과 실제 배포, 사이트 데이터·미디어 쓰기와 데이터베이스 클라이언트 등록에서 호출합니다(읽기는 방문자 트래픽이라 제외). 실패해도 기능 자체를 막지 않도록 기다리지 않고 기록하며, 5분 안에 이미 남은 기록은 다시 쓰지 않습니다. 환불 판정과 `/admin`의 '기능 사용' 칸이 이 표를 읽습니다. 방문자 현황은 열어보는 것이 전부인 기능이라 기록만 남기고 환불 조건은 없애지 않습니다(`REFUND_BLOCKING_FEATURES`에서 제외). `/admin`은 조건을 없애지 않는 사용을 흐리게 적고 '환불 조건 유지'를 덧붙입니다.
- **환불 정책**: 웹훅과 매일 04:15의 `sync-payment-refunds.ts`가 Toss의 취소 내역과 환불 금액을 원장에 동기화합니다. 환불된 결제는 그 결제가 부여한 기간을 되돌립니다. 나루는 부분 환불을 제공하지 않으므로, 환불 금액이 있으면 결제 전체를 되돌린 것으로 봅니다. `supporter_until`은 환불되지 않은 결제 원장에서 다시 계산하므로, 다른 결제가 산 기간은 건드리지 않고 줄어들기만 합니다. 환불된 정기 후원은 자동 갱신도 취소하고 빌링키를 제거합니다.
- **운영 진단**: 결제 대사를 실행할 때마다 `last_reconciled_at`과 `reconciliation_error`를 기록합니다. 결제 운영자는 `/admin`에서 전체 사용자의 최근 결제, 대기·실패 상태, 환불, 구독 상태, 결제 후 후원자 기능 사용 여부, Toss 불일치를 확인하고 수동 대사와 환불을 실행할 수 있습니다.
- **이메일 알림**: 후원 시작/한 번만 후원 성공 시 한국어 인디웹 후원 감사 메일을 보냅니다. cron의 `send-billing-notifications.ts`(매일 09:00)가 다음 결제일 3일 이내인 인증된 이메일 계정에 갱신 예정 안내를 보냅니다. `charge-subscriptions.ts`는 갱신 결제 첫 실패 시 결제 유예 기간 안내를 한 번 보냅니다.
- **취소**: `subscription/cancel`은 `status='canceled'`로 두고 `supporter_until`은 유지 → 결제한 기간 동안은 계속 이용 가능.
- **커스텀 도메인 회수**: cron의 `cleanup-expired-custom-domains.ts`(매일 04:30)가 `supporter_until + PAYMENT_GRACE_DAYS`가 지난 비-comp 계정의 Cloudflare for SaaS Custom Hostname을 삭제한 뒤 로컬 `custom_domains` 행을 제거합니다. 이미 Cloudflare에서 삭제된 404는 성공으로 처리합니다.
- **웹훅**: 일반 결제 웹훅에는 서명이 없으므로 payload를 신뢰하지 않습니다. `api/webhooks/toss`는 `orderId`로 Toss API를 다시 조회하고 금액과 상태를 확인한 뒤 원장을 동기화합니다. 성공 결제의 엔티틀먼트 부여는 confirm/cron의 원자적 처리에서만 수행합니다.

## 데이터 모델

- `users.supporter_comp` / `users.supporter_until` / `users.toss_customer_key`
- `subscriptions`: 사용자당 한 행. `plan`, `billing_interval`, `amount`, `status`(`incomplete`/`active`/`past_due`/`canceled`), `toss_billing_key`(서버 전용), 기간 필드.
- `payments`: Toss 청구 시도/성공 원장. `refunded_amount`, `refunded_at`은 Toss에서 확인한 누적 환불 정보이고, `last_reconciled_at`, `reconciliation_error`는 최근 대사 진단입니다.
- `supporter_feature_uses`: `(user_id, feature)`가 기본키. 후원자 전용 기능을 언제 처음/마지막으로 썼는지만 남기는 표로, 환불 조건 판정에 씁니다.

## 환경 변수

- `TOSS_CLIENT_KEY`: 서버에서 읽어 클라이언트로 전달하는 공개 키.
- `TOSS_SECRET_KEY`: 서버 전용 시크릿 키.
- `RESEND_API_KEY` / `FROM_EMAIL` / `BASE_URL`: 결제 갱신/실패 안내 메일 발송에 사용합니다.

개발/테스트에는 Toss 테스트 키를 사용하세요.
