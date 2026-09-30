# 유료 서비스와 결제 (Toss Payments)

유료 기능은 **시간 기반 엔티틀먼트**로 제어됩니다. 영구 무료 제공 계정은 `users.supporter_comp`, 결제로 얻은 유료 기간은 `users.supporter_until`(유료 기간이 끝나는 시각)로 나타냅니다. 접근 권한 = `supporter_comp OR supporter_until + PAYMENT_GRACE_DAYS > now()`입니다. 즉 `supporter_until`은 유료 기간 경계로 남고, 결제 유예 기간 동안은 유료 기능도 계속 열려 있습니다.

기능 묶음은 `lib/entitlements.ts`의 `PLAN_FEATURES`에 정의됩니다. 지금은 `supporter → [custom_domains, github_deploys, analytics]`입니다. 새 플랜은 키를 추가해 확장합니다.

유료 기능 설정은 `/domains`(커스텀 도메인)과 `/deploys`(GitHub 배포)에서 관리합니다. 결제 흐름은 `/support`에 남겨둡니다. `/support`는 광고하지 않습니다 — 결제한 적 없는 방문자에게는 어디에도 보이지 않고, 카드사 심사관은 주소를 직접 받습니다. 다만 결제한 적이 있거나 현재 유료 기능을 이용 중인 계정에는 계정 메뉴에 '결제'가 뜹니다(`hasSupportRelationship`). 결제 내역·정기 결제 취소·환불 신청이 모두 그 아래에 있어서, 링크가 없으면 판매 정책에 적어 둔 환불 창구가 주소를 아는 사람에게만 열립니다.

결제는 **Toss Payments 자동결제(빌링)** 입니다. 월 1,000원 / 연 10,000원.

- **이메일 인증 선행**: 결제를 시작하려면 인증된 이메일 주소가 있어야 합니다. `subscription/prepare`와 `donation/one-time/prepare`는 `users.email`과 `users.email_verified_at`이 모두 채워져 있지 않으면 403을 반환하고, `/support`의 결제 카드도 결제 버튼 대신 인증 안내와 인증 메일 재발송 버튼을 보여줍니다. 영수증, 갱신 예정 안내, 결제 실패 안내를 반드시 전달할 수 있어야 하기 때문입니다.
- **구독 시작**: `subscription/prepare`가 플랜을 `incomplete` 구독으로 기록하고 `customerKey`를 반환 → 프런트가 `requestBillingAuth`로 카드 등록 → `/account/subscription/callback`이 `subscription/confirm` 호출 → 빌링키 발급 후 첫 결제, `subscriptions`를 `active`로, `supporter_until`을 채웁니다. 남은 유료 기간이 있으면 첫 결제는 그 기간이 끝나는 시각으로 예약(`scheduled`)되고, 이전 구독에서 남은 안내 발송 기록은 지워서 첫 결제 전 안내가 다시 나가게 합니다. confirm은 청구 리스(`charging_started_at`)를 먼저 잡으므로 콜백이 두 번 호출돼도 한 번만 청구합니다. 금액은 항상 서버(`lib/toss.ts`의 `PLAN_AMOUNTS`)에서 결정합니다.
- **자동 갱신**: cron의 `charge-subscriptions.ts`(매일 04:00)가 `next_billing_at`이 지난 활성 구독을 빌링키로 청구해 기간을 연장합니다. 실패 시 결제 유예 기간 안에서 `MAX_PAYMENT_RETRY_ATTEMPTS`까지 재시도합니다. 재시도 한도나 유예 기간 끝에 도달하면 `past_due`로 전환됩니다. 예약된 첫 결제가 실패하면 재시도하는 동안 `scheduled`로 남습니다. 청구 직전에 구독이 아직 청구 가능한지 다시 확인하고, 청구 도중 취소·환불·한 번만 결제 전환이 일어나면 그 상태를 덮어쓰지 않습니다 — 이미 청구된 돈의 기간은 부여하되 자동 갱신은 되살리지 않습니다. 어떤 청구도 `supporter_until`을 줄이지 않고, 한 번만 결제로 앞서 쌓인 기간 뒤에 이어 붙입니다. 월 단위 기간은 달의 마지막 날로 맞춥니다(1월 31일 → 2월 28일). 청구 로직은 `lib/subscription-renewals.ts`에 있습니다. Toss는 한 번 쓴 `orderId`를 다시 받지 않고, 멱등키마다 첫 응답(에러 포함)을 15일 동안 그대로 돌려줍니다. 그래서 결과가 불분명한 `pending` 주문은 같은 주문번호·멱등키로 다시 확인하고, 대사가 Toss에 없는 주문이라고 확인해 `expired`로 만든 뒤에는 새 주문번호로 청구합니다(`attempt_key`에 `:r1`, `:r2`…). Toss가 `ABORTED`(승인 거절)로 알려 준 주문은 다시 청구하지 않고 실패 1회로 셉니다.
- **자동 대사**: `reconcile-payments.ts`가 5분마다 오래된 `pending` 주문을 Toss에서 조회합니다. 결제가 완료됐으면 결제 원장과 이용 기간을 한 트랜잭션으로 확정하고, 확인되지 않은 주문은 30분 뒤 만료합니다. 사용자는 결제 내역의 “다시 확인”으로 즉시 같은 대사를 요청할 수도 있습니다.
- **환불 신청**: 유료 이용자는 `/support/payments`의 '환불 신청'으로 직접 환불합니다. `api/account/payments/[id]/refund`가 `lib/refunds.ts`의 `refundEligibility`로 조건을 확인한 뒤 Toss 결제를 취소하고 곧바로 대사합니다. 조건은 결제일로부터 `REFUND_WINDOW_DAYS`(7일) 이내인지 하나뿐입니다 — 유료 기능을 썼는지는 묻지 않습니다. 무엇을 묻는지가 곧 무엇을 증명하라는 요구가 되기 때문입니다. 조건에 맞지 않으면 그 사유(기간 경과·이미 환불됨·결제 미완료)를 그대로 돌려주므로 메일로 다시 물을 일이 없습니다. 결제 취소 요청에는 멱등키를 쓰지 않습니다 — 한 번 실패한 응답이 15일 동안 재생돼 7일 환불 기간 안에 다시 시도할 수 없게 되기 때문입니다. 전액 취소는 Toss가 두 번 처리하지 않으므로 그대로 안전합니다. 취소가 거절되면(`ALREADY_CANCELED_PAYMENT`, `NOT_CANCELABLE_PAYMENT` 등) Toss에서 결제를 다시 조회해, 이미 취소된 결제면 원장만 맞추고 성공으로 처리합니다. `PAYMENT_OPERATOR_USERS`는 같은 엔드포인트를 `/admin`에서 호출하며, 장애 보상처럼 정책 밖의 환불도 기간·사용 여부와 관계없이 실행할 수 있습니다. 환불이 처리되면 해당 계정의 정기 결제도 함께 취소하고 빌링키를 지워 다시 청구되지 않게 합니다.
- **유료 기능 사용 기록**: `supporter_feature_uses`(계정×기능당 한 행, `first_used_at`/`last_used_at`)가 유료 기능이 실제로 쓰였는지를 기록합니다. `lib/feature-usage.ts`의 `noteSupporterFeatureUse`를 방문자 현황 조회, 커스텀 도메인 등록, GitHub 배포 대상 저장과 실제 배포, 사이트 데이터·미디어 쓰기와 데이터베이스 클라이언트 등록에서 호출합니다(읽기는 방문자 트래픽이라 제외). 실패해도 기능 자체를 막지 않도록 기다리지 않고 기록하며, 5분 안에 이미 남은 기록은 다시 쓰지 않습니다. `/admin`의 '기능 사용' 칸이 이 표를 읽습니다. 환불 판정에는 쓰지 않습니다 — 7일 안이면 사용 여부와 관계없이 환불되므로, 운영자가 계정을 이해할 때 보는 정보입니다.
- **환불 정책**: 웹훅과 매일 04:15의 `sync-payment-refunds.ts`가 Toss의 취소 내역과 환불 금액을 원장에 동기화합니다. 환불된 결제는 그 결제가 부여한 기간을 되돌립니다. 나루는 부분 환불을 제공하지 않으므로, 환불 금액이 있으면 결제 전체를 되돌린 것으로 봅니다. `supporter_until`은 환불되지 않은 결제 원장을 순서대로 다시 쌓아 계산하므로 줄어들기만 합니다. 환불된 기간 뒤에 이어 붙어 있던 기간은 앞으로 당겨지지만, 결제한 시각보다 앞으로 가지는 않습니다. 환불된 정기 결제는 자동 갱신도 취소하고 빌링키를 제거합니다.
- **운영 진단**: 결제 대사를 실행할 때마다 `last_reconciled_at`과 `reconciliation_error`를 기록합니다. 결제 운영자는 `/admin`에서 전체 사용자의 최근 결제, 대기·실패 상태, 환불, 구독 상태, 결제 후 유료 기능 사용 여부, Toss 불일치를 확인하고 수동 대사와 환불을 실행할 수 있습니다.
- **이메일 알림**: 결제 시작/한 번만 결제 성공 시 한국어 인디웹 결제 감사 메일을 보냅니다. cron의 `send-billing-notifications.ts`(매일 09:00)가 다음 결제일 3일 이내인 인증된 이메일 계정에 갱신 예정 안내를 보냅니다. `charge-subscriptions.ts`는 갱신 결제 첫 실패 시 결제 유예 기간 안내를 한 번 보냅니다.
- **취소**: `subscription/cancel`은 `status='canceled'`로 두고 `supporter_until`은 유지 → 결제한 기간 동안은 계속 이용 가능.
- **커스텀 도메인 회수**: cron의 `cleanup-expired-custom-domains.ts`(매일 04:30)가 `supporter_until + PAYMENT_GRACE_DAYS`가 지난 비-comp 계정의 Cloudflare for SaaS Custom Hostname을 삭제한 뒤 로컬 `custom_domains` 행을 제거합니다. 이미 Cloudflare에서 삭제된 404는 성공으로 처리합니다.
- **빌링키 삭제**: 빌링키는 Toss에서 만료되지 않고, 나루는 빌링키를 암호화하지 않고 저장합니다. 그래서 더 이상 쓰지 않는 빌링키는 Toss에서도 지웁니다. 빌링키를 비우는 모든 경로(취소·환불·한 번만 결제 전환·재등록·`BILLING_DELETED`)는 `lib/billing-keys.ts`의 `retireBillingKey`를, 계정 삭제는 `lib/account-deletion.ts`의 `deleteUserRow`를 거칩니다. `retireBillingKey`는 호출한 쪽의 트랜잭션 안에서 키를 `retired_billing_keys`에 넣고 컬럼을 비웁니다. 트랜잭션이 커밋되면 호출한 쪽이 `deleteRetiredBillingKey`로 곧바로 빌링키 삭제 API(`DELETE /v1/billing/{billingKey}`)를 부르고, Toss가 확인하면(이미 없는 키 포함) 행을 지워 평문 사본을 남기지 않습니다. Toss가 응답하지 않았거나 커밋 직후 프로세스가 죽었으면 행이 남고, cron의 `delete-retired-billing-keys.ts`(5분마다)가 다시 시도합니다. 데이터베이스는 이 규칙을 강제하지 않으므로, `toss_billing_key`를 다른 곳에서 비우거나 `users` 행을 다른 곳에서 지우면 `billing-key-writes-payment.test.ts`가 실패합니다. 실패한 키는 `attempts`/`last_error`를 남기고 한 시간 뒤 다시 시도합니다.
- **웹훅**: 일반 결제 웹훅에는 서명이 없으므로 payload를 신뢰하지 않습니다. `api/webhooks/toss`는 `orderId`로 Toss API를 다시 조회하고 금액과 상태를 확인한 뒤 원장을 동기화합니다. 성공 결제의 엔티틀먼트 부여는 confirm/cron/대사의 원자적 처리에서만 수행합니다. `BILLING_DELETED`는 다른 이벤트처럼 `data.billingKey`로 오며, 받으면 그 키를 쓰는 구독을 취소하고 삭제 대기열에서도 뺍니다(Toss에서 이미 지워졌으므로). 자동결제는 승인 완료 시 `PAYMENT_STATUS_CHANGED`를 보내지 않으니 청구 결과는 웹훅에 기대지 않습니다. 웹훅이 원장 상태를 바꾸는 건 아직 `pending`인 결제가 `aborted`/`expired`/`failed`로 끝났을 때와 취소(대사)뿐입니다 — `READY`·`IN_PROGRESS` 같은 중간 상태를 적으면 그 결제는 confirm도 대사도 할 수 없게 됩니다.

## 데이터 모델

- `users.supporter_comp` / `users.supporter_until` / `users.toss_customer_key`
- `subscriptions`: 사용자당 한 행. `plan`, `billing_interval`, `amount`, `status`(`incomplete`/`active`/`past_due`/`canceled`), `toss_billing_key`(서버 전용), 기간 필드.
- `retired_billing_keys`: Toss에서 아직 지우지 못한 옛 빌링키 대기열. 삭제가 확인되면 행이 사라집니다.
- `payments`: Toss 청구 시도/성공 원장. `refunded_amount`, `refunded_at`은 Toss에서 확인한 누적 환불 정보이고, `last_reconciled_at`, `reconciliation_error`는 최근 대사 진단입니다.
- `supporter_feature_uses`: `(user_id, feature)`가 기본키. 유료 기능을 언제 처음/마지막으로 썼는지만 남기는 표로, 환불 조건 판정에 씁니다.

## 환경 변수

- `TOSS_CLIENT_KEY`: 서버에서 읽어 클라이언트로 전달하는 공개 키.
- `TOSS_SECRET_KEY`: 서버 전용 시크릿 키.
- `RESEND_API_KEY` / `FROM_EMAIL` / `BASE_URL`: 결제 갱신/실패 안내 메일 발송에 사용합니다.

개발/테스트에는 Toss 테스트 키를 사용하세요.

## 테스트

- `pnpm test:payments`: DB 없이 도는 결제 단위 테스트.
- `pnpm test:payments:db`: 새 로컬 PostgreSQL 클러스터를 띄워 최신 스키마로 마이그레이션한 뒤, 기간 부여·청구 리스·갱신 cron·환불 대사를 실제 트랜잭션으로 확인합니다. `initdb`는 root로 실행할 수 없으니 일반 사용자로 실행하세요.
