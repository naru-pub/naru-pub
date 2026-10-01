# 유료 서비스와 결제 (Toss Payments)

유료 기능은 **시간 기반 엔티틀먼트**로 제어됩니다. 영구 무료 제공 계정은 `users.supporter_comp`, 결제로 얻은 유료 기간은 `users.supporter_until`(유료 기간이 끝나는 시각)로 나타냅니다. 접근 권한 = `supporter_comp OR supporter_until + PAYMENT_GRACE_DAYS > now()`입니다. 즉 `supporter_until`은 유료 기간 경계로 남고, 결제 유예 기간 동안은 유료 기능도 계속 열려 있습니다.

기능 묶음은 `lib/entitlements.ts`의 `PLAN_FEATURES`에 정의됩니다. 지금은 `supporter → [custom_domains, github_deploys, analytics]`입니다. 새 플랜은 키를 추가해 확장합니다.

유료 기능 설정은 `/domains`(커스텀 도메인)과 `/deploys`(GitHub 배포)에서 관리합니다. 결제 흐름은 `/support`에 남겨둡니다. `/support`는 광고하지 않습니다 — 결제한 적 없는 방문자에게는 어디에도 보이지 않고, 카드사 심사관은 주소를 직접 받습니다. 다만 결제한 적이 있거나 현재 유료 기능을 이용 중인 계정에는 계정 메뉴에 '결제'가 뜹니다(`hasSupportRelationship`). 결제 내역·정기 결제 취소·환불 신청이 모두 그 아래에 있어서, 링크가 없으면 판매 정책에 적어 둔 환불 창구가 주소를 아는 사람에게만 열립니다.

결제는 **Toss Payments 자동결제(빌링)** 입니다. 월 1,000원 / 연 10,000원.

- **이메일 인증 선행**: 결제를 시작하려면 인증된 이메일 주소가 있어야 합니다. `subscription/prepare`와 `donation/one-time/prepare`는 `users.email`과 `users.email_verified_at`이 모두 채워져 있지 않으면 403을 반환하고, `/support`의 결제 카드도 결제 버튼 대신 인증 안내와 인증 메일 재발송 버튼을 보여줍니다. 영수증, 갱신 예정 안내, 결제 실패 안내를 반드시 전달할 수 있어야 하기 때문입니다.
- **구독 시작**: `subscription/prepare`가 플랜을 `incomplete` 구독으로 기록하고 `customerKey`를 반환 → 프런트가 `requestBillingAuth`로 카드 등록 → `/account/subscription/callback`이 `subscription/confirm` 호출 → 빌링키 발급 후 첫 결제, `subscriptions`를 `active`로, `supporter_until`을 채웁니다. 두 단계의 로직은 `lib/subscription-signup.ts`에 있고 라우트는 HTTP로 옮기기만 합니다. 남은 유료 기간이 있으면 첫 결제는 그 기간이 끝나는 시각으로 예약(`scheduled`)되고, 이전 구독에서 남은 안내 발송 기록은 지워서 첫 결제 전 안내가 다시 나가게 합니다. confirm은 `incomplete` 구독에서만 청구 리스(`charging_started_at`)를 잡으므로 콜백이 두 번 호출돼도 한 번만 청구하고, 브라우저 기록에 남은 옛 콜백이 `past_due`·`canceled` 구독을 청구하지도 않습니다. 금액은 항상 서버(`lib/toss.ts`의 `PLAN_AMOUNTS`)에서 결정합니다.
  - prepare는 기존 구독의 결과가 불분명한(`pending`) 주문을 먼저 대사합니다. 여전히 불분명하면 409로 거절합니다 — 새 카드가 옛 주문번호·멱등키로 청구되거나, 늦게 확인된 옛 결제가 새 카드 등록과 엇갈리지 않게 하려는 것입니다. 갱신 청구가 리스를 잡고 있는 동안에도 거절합니다.
  - 빌링키 발급 요청은 `authKey`에서 만든 멱등키를 씁니다. `authKey`는 한 번만 쓸 수 있으므로 응답을 잃고 다시 요청하면 이미 발급된 키를 그대로 돌려받아야 합니다. 발급이 명확히 거절되면(만료·재사용된 `authKey`, 카드 거절) 402로 사유를 돌려줍니다.
  - 발급된 키는 구독이 아직 `incomplete`이고 키가 비어 있을 때만 저장합니다. 취소는 confirm의 리스를 기다리지 않으므로, 발급 중에 취소가 끼어들면 그 키는 저장하지 않고 곧바로 Toss에서 지웁니다(`discardIssuedBillingKey`). 청구 직전에도 구독이 그대로인지 다시 확인합니다.
  - 첫 결제가 명확히 실패하면(카드 거절 등) 그 가입에 쓴 빌링키를 곧바로 폐기합니다. 다시 시도하려면 카드를 새로 등록합니다. 결과가 불분명하면 키와 주문을 그대로 두고, 대사가 그 주문이 Toss에 없거나 거절됐다고 확인하면 그때 키를 폐기합니다(`retireUnusedSignupKey`, 리스가 살아 있는 가입은 건드리지 않음).
- **자동 갱신**: cron의 `charge-subscriptions.ts`(매일 04:00)가 `next_billing_at`이 지난 활성 구독을 빌링키로 청구해 기간을 연장합니다. 한 번 실행에서 기한이 된 구독을 10개씩 모두 처리하고(같은 실행 안에서 한 구독을 두 번 시도하지는 않음), 자동결제 승인은 최대 60초가 걸리므로 Toss 요청은 90초 뒤에 포기해 결과 불분명으로 다룹니다. 묶음 크기는 대기 중인 구독의 리스가 `CHARGE_LEASE_MINUTES` 안에 끝나도록 정한 값입니다. 실패 시 결제 유예 기간 안에서 `MAX_PAYMENT_RETRY_ATTEMPTS`까지 재시도합니다. 재시도 한도나 유예 기간 끝에 도달하면 `past_due`로 전환됩니다. 예약된 첫 결제가 실패하면 재시도하는 동안 `scheduled`로 남습니다. 청구 직전에 구독이 아직 청구 가능한지 다시 확인하고, 청구 도중 취소·환불·한 번만 결제 전환이 일어나면 그 상태를 덮어쓰지 않습니다 — 이미 청구된 돈의 기간은 부여하되 자동 갱신은 되살리지 않습니다. 어떤 청구도 `supporter_until`을 줄이지 않고, 한 번만 결제로 앞서 쌓인 기간 뒤에 이어 붙입니다. 월 단위 기간은 달의 마지막 날로 맞추고(1월 31일 → 2월 28일), 서버 시간대와 관계없이 한국 시간 달력으로 셉니다. 청구 로직은 `lib/subscription-renewals.ts`에 있습니다. Toss는 한 번 쓴 `orderId`를 다시 받지 않고, 멱등키마다 첫 응답(에러 포함)을 15일 동안 그대로 돌려줍니다. 그래서 결과가 불분명한 `pending` 주문은 같은 주문번호·멱등키로 다시 확인하고, 대사가 Toss에 없는 주문이라고 확인해 `expired`로 만든 뒤에는 새 주문번호로 청구합니다(`attempt_key`에 `:r1`, `:r2`…). Toss가 `ABORTED`(승인 거절)로 알려 준 주문은 다시 청구하지 않고 실패 1회로 셉니다. 결과가 불분명한 청구는 실패로 세지 않지만(주문번호를 바꾸면 이중 청구가 될 수 있으므로), 유예 기간이 끝나면 `past_due`로 바꿉니다. 그 주문이 나중에 결제 완료로 확인되면 대사가 다시 `active`로 돌립니다. 빌링키가 없는 구독(새 카드 등록 중에 옛 갱신이 늦게 확인된 경우)은 기간만 부여하고 `active`로 바꾸지 않아, 새 카드의 confirm이 키를 저장하고 첫 결제를 예약할 수 있게 합니다. 이미 `pending`이 아닌 주문(만료·실패·환불)에는 기간을 다시 부여하지 않습니다.
- **자동 대사**: `reconcile-payments.ts`가 5분마다 오래된 `pending` 주문을 Toss에서 조회합니다. 결제가 완료됐으면 결제 원장과 이용 기간을 한 트랜잭션으로 확정하고, 확인되지 않은 주문은 30분 뒤 만료합니다. 사용자는 결제 내역의 “다시 확인”으로 즉시 같은 대사를 요청할 수도 있습니다.
- **환불 신청**: 유료 이용자는 `/support/payments`의 '환불 신청'으로 직접 환불합니다. `api/account/payments/[id]/refund`가 `lib/refunds.ts`의 `refundEligibility`로 조건을 확인한 뒤 Toss 결제를 취소하고 곧바로 대사합니다. 조건은 결제일로부터 `REFUND_WINDOW_DAYS`(7일) 이내인지 하나뿐입니다 — 유료 기능을 썼는지는 묻지 않습니다. 무엇을 묻는지가 곧 무엇을 증명하라는 요구가 되기 때문입니다. 조건에 맞지 않으면 그 사유(기간 경과·이미 환불됨·결제 미완료)를 그대로 돌려주므로 메일로 다시 물을 일이 없습니다. 결제 취소 요청에는 멱등키를 쓰지 않습니다 — 한 번 실패한 응답이 15일 동안 재생돼 7일 환불 기간 안에 다시 시도할 수 없게 되기 때문입니다. 전액 취소는 Toss가 두 번 처리하지 않으므로 그대로 안전합니다. 취소가 거절되면(`ALREADY_CANCELED_PAYMENT`, `NOT_CANCELABLE_PAYMENT` 등) Toss에서 결제를 다시 조회해, 이미 취소된 결제면 원장만 맞추고 성공으로 처리합니다. `PAYMENT_OPERATOR_USERS`는 같은 엔드포인트를 `/admin`에서 호출하며, 장애 보상처럼 정책 밖의 환불도 기간·사용 여부와 관계없이 실행할 수 있습니다. 환불이 처리되면 해당 계정의 정기 결제도 함께 취소하고 빌링키를 지워 다시 청구되지 않게 합니다.
- **유료 기능 사용 기록**: `supporter_feature_uses`(계정×기능당 한 행, `first_used_at`/`last_used_at`)가 유료 기능이 실제로 쓰였는지를 기록합니다. `lib/feature-usage.ts`의 `noteSupporterFeatureUse`를 방문자 현황 조회, 커스텀 도메인 등록, GitHub 배포 대상 저장과 실제 배포, 사이트 데이터·미디어 쓰기와 데이터베이스 클라이언트 등록에서 호출합니다(읽기는 방문자 트래픽이라 제외). 실패해도 기능 자체를 막지 않도록 기다리지 않고 기록하며, 5분 안에 이미 남은 기록은 다시 쓰지 않습니다. `/admin/payments`의 '기능 사용' 칸이 이 표를 읽습니다. 환불 판정에는 쓰지 않습니다 — 7일 안이면 사용 여부와 관계없이 환불되므로, 운영자가 계정을 이해할 때 보는 정보입니다.
- **환불 정책**: 웹훅과 매일 04:15의 `sync-payment-refunds.ts`(`lib/refund-sync.ts`)가 Toss의 취소 내역과 환불 금액을 원장에 동기화합니다. 환불된 결제는 그 결제가 부여한 기간을 되돌립니다. 나루는 부분 환불을 제공하지 않으므로, 환불 금액이 있으면 결제 전체를 되돌린 것으로 봅니다. `supporter_until`은 환불되지 않은 결제 원장을 순서대로 다시 쌓아 계산하므로 줄어들기만 합니다. 환불된 기간 뒤에 이어 붙어 있던 기간은 앞으로 당겨지지만, 결제한 시각보다 앞으로 가지는 않습니다. 환불된 정기 결제는 자동 갱신도 취소하고 빌링키를 제거합니다.
- **환불 동기화 주기**: 웹훅이 빠른 길이고, 동기화는 놓친 웹훅을 잡는 안전망입니다. 카드 결제는 Toss에 취소 기한이 없지만 카드사의 결제 데이터 보관 기간 때문에 1년이 지나면 취소가 안 될 수 있고, 결제 조회는 5년 전까지만 됩니다. 그래서 결제 후 경과 기간마다 다시 확인하는 간격이 다릅니다 — 환불 기간(7일)+30일까지는 매일, 400일까지는 매주, 5년까지는 매달, 그 뒤로는 확인하지 않습니다(`REFUND_SYNC_TIERS`). 건수 제한은 없습니다. 마지막 확인(`last_reconciled_at`)이 가장 오래된 결제부터 확인하고, 50분 예산을 다 쓰면 멈춥니다. 남은 결제는 계속 확인 대상이라 다음 실행이 그것부터 이어 갑니다.
- **운영 진단**: 결제 대사를 실행할 때마다 `last_reconciled_at`과 `reconciliation_error`를 기록합니다. 결제 운영자는 `/admin`(개요)과 `/admin/payments`에서 전체 사용자의 최근 결제, 대기·실패 상태, 환불, 구독 상태, 결제 후 유료 기능 사용 여부, Toss 불일치를 확인하고 수동 대사와 환불을 실행할 수 있습니다.
- **이메일 알림**: 결제 시작/한 번만 결제 성공 시 한국어 인디웹 결제 감사 메일을 보냅니다. cron의 `send-billing-notifications.ts`(매일 09:00)가 다음 결제일 3일 이내인 인증된 이메일 계정에 갱신 예정 안내를 보냅니다. `charge-subscriptions.ts`는 갱신 결제 첫 실패 시 결제 유예 기간 안내를 한 번 보냅니다.
- **취소**: `subscription/cancel`은 `status='canceled'`로 두고 `supporter_until`은 유지 → 결제한 기간 동안은 계속 이용 가능.
- **커스텀 도메인 회수**: cron의 `cleanup-expired-custom-domains.ts`(매일 04:30)가 `supporter_until + PAYMENT_GRACE_DAYS`가 지난 비-comp 계정의 Cloudflare for SaaS Custom Hostname을 삭제한 뒤 로컬 `custom_domains` 행을 제거합니다. 이미 Cloudflare에서 삭제된 404는 성공으로 처리합니다.
- **빌링키 삭제**: 빌링키는 Toss에서 만료되지 않고, 나루는 빌링키를 암호화하지 않고 저장합니다. 그래서 더 이상 쓰지 않는 빌링키는 Toss에서도 지웁니다. 빌링키를 비우는 모든 경로(취소·환불·한 번만 결제 전환·재등록·`BILLING_DELETED`)는 `lib/billing-keys.ts`의 `retireBillingKey`를, 계정 삭제는 `lib/account-deletion.ts`의 `deleteUserRow`를 거칩니다. `retireBillingKey`는 호출한 쪽의 트랜잭션 안에서 키를 `retired_billing_keys`에 넣고 컬럼을 비웁니다. 트랜잭션이 커밋되면 호출한 쪽이 `deleteRetiredBillingKey`로 곧바로 빌링키 삭제 API(`DELETE /v1/billing/{billingKey}`)를 부르고, Toss가 확인하면(이미 없는 키 포함) 행을 지워 평문 사본을 남기지 않습니다. Toss가 응답하지 않았거나 커밋 직후 프로세스가 죽었으면 행이 남고, cron의 `delete-retired-billing-keys.ts`(5분마다)가 다시 시도합니다. 데이터베이스는 이 규칙을 강제하지 않으므로, `toss_billing_key`를 다른 곳에서 비우거나 `users` 행을 다른 곳에서 지우면 `billing-key-writes-payment.test.ts`가 실패합니다. 실패한 키는 `attempts`/`last_error`를 남기고 한 시간 뒤부터 두 배씩 늘려(최대 하루) 다시 시도합니다. Toss에 없는 키를 지울 때 Toss가 어떻게 답하는지 문서가 밝히지 않아서, 그런 거절이 영원히 매시간 반복되지 않게 하려는 것입니다. 다섯 번 넘게 실패하면 `STUCK`으로 로그를 남기니 `last_error`를 확인하세요.
- **웹훅**: 받은 웹훅마다 로그 한 줄(`[toss-webhook] …`)과 `toss_webhook_deliveries` 한 행을 남깁니다 — 무엇이 왔고, Toss에서 다시 조회한 상태가 무엇이었고, 나루가 무엇을 했는지. 일반 결제 웹훅에는 서명이 없으므로 payload를 신뢰하지 않습니다. `api/webhooks/toss`는 `orderId`로 Toss API를 다시 조회하고 금액과 상태를 확인한 뒤 원장을 동기화합니다. 성공 결제의 엔티틀먼트 부여는 confirm/cron/대사의 원자적 처리에서만 수행합니다. 조회한 결제는 `orderId`·금액·MID(`toss_mid`를 알 때)가 모두 맞아야 반영합니다. `BILLING_DELETED`는 다른 이벤트처럼 `data.billingKey`로 오며, 받으면 그 키를 쓰는 구독을 취소하고 삭제 대기열에서도 뺍니다(Toss에서 이미 지워졌으므로). 빌링키는 조회 API가 없어 이 이벤트만은 다시 확인할 수 없으므로, `SITE_DATA_TRUST_CLOUDFLARE_IP=1`(인그레스가 `CF-Connecting-IP`를 덮어쓰는 배포)에서는 Toss가 공개한 웹훅 발신 IP에서 온 것만 받습니다. 자동결제는 승인 완료 시 `PAYMENT_STATUS_CHANGED`를 보내지 않으니 청구 결과는 웹훅에 기대지 않습니다. 웹훅이 원장 상태를 바꾸는 건 아직 `pending`인 결제가 `aborted`/`expired`/`failed`로 끝났을 때와 취소(대사)뿐입니다 — `READY`·`IN_PROGRESS` 같은 중간 상태를 적으면 그 결제는 confirm도 대사도 할 수 없게 됩니다.

## 운영 페이지 (`/admin`)

결제 운영자(`PAYMENT_OPERATOR_USERS`)만 들어옵니다. 탭은 다음과 같습니다.

- **개요** (`/admin`): 결제·정기 결제·웹훅의 주요 수치. 카드마다 그 수를 이룬 행을 그대로 보여 주는 상세 화면으로 이어집니다. 카드의 조건은 `admin/_components/metrics.ts`에 한 번만 정의해 카드 숫자와 상세 목록이 같은 조건을 쓰고, 테스트가 각 조건이 고르는 행과 유료 이용자 조건이 `getUserEntitlement`와 같은지 확인합니다. 문제가 있는 칸은 빨갛게 표시됩니다.
- **결제** (`/admin/payments`): `?filter=`로 최근 30일 결제·최근 30일 환불·대기 중·대사 오류·최근 7일 실패를 거르고, 전체 건수와 금액은 표시된 200건이 아니라 조건 전체로 셉니다. 대사·환불 버튼.
- **정기 결제** (`/admin/subscriptions`): 상태별로 거른 구독, 다음 결제일·실패 횟수·(가린) 빌링키.
- **유료 이용자** (`/admin/supporters`): 지금 유료 기능을 쓸 수 있는 계정 — 무료 제공, 이용 기한이 남은 계정, 결제 유예 중인 계정.
- **결제 이벤트** (`/admin/events`): 아래 '결제 이벤트 알림'의 기록과 메일 발송 여부. 종류·계정·메일 대기로 거릅니다.
- **웹훅** (`/admin/webhooks`): 받은 웹훅 하나하나와 나루가 한 일, 응답 코드, (가린) 본문. 기간(24시간·7일)과 5xx로 거릅니다.
- **빌링키 삭제** (`/admin/billing-keys`): Toss에서 아직 지우지 못한 빌링키와 시도 횟수·마지막 오류.
- **결제 실험실** (`/admin/lab`): 테스트 키 환경에서만 보입니다(아래).
- **게시판** (`/admin/board`).

## 결제 이벤트 알림

결제와 정기 결제의 상태가 바뀌는 곳마다 `payment_events`에 한 줄을 남깁니다(`lib/payment-events.ts`). 대부분 그 변경과 같은 트랜잭션 안에서 기록하므로, 이벤트는 변경이 실제로 일어났을 때만 남습니다. 종류: 결제 완료(정기·한 번만), 결제 실패, 결과 불분명, 연체(past_due) 전환, 환불, 정기 결제 예약, 정기 결제 취소(사용자·환불), 빌링키 삭제(`BILLING_DELETED`), 주문 만료(결제창을 닫은 주문 포함), 빌링키 삭제 지연(5번 실패).

운영 환경 — 모든 Toss 키가 라이브 키(`live_…`)일 때(`isTossLiveMode`) — 에서는 cron의 `send-payment-event-digest.ts`(매분)가 아직 보내지 않은 이벤트를 `hello@naru.pub`로 **한 통에 묶어** 보냅니다. 새 이벤트가 2분 동안 없으면 보내고, 이벤트가 계속 들어와도 가장 오래된 것이 15분을 기다렸으면 보냅니다. 그래서 갱신 cron 한 번, 결제 실패와 그 안내, 환불과 그에 따른 정기 결제 취소는 한 통으로 옵니다. 보낸 뒤에야 `emailed_at`을 적으므로, 발송이 실패하면 다음 실행이 다시 보냅니다. 테스트 키 환경에서는 기록만 하고 보내지 않습니다.

이벤트는 1년, 웹훅 기록(`toss_webhook_deliveries`)은 90일 보관하고 같은 cron이 지웁니다.

## 결제 실험실 (`/admin/lab`)

모든 Toss 시크릿 키가 테스트 키(`test_…`)인 환경에서만 나타납니다(`isTossTestMode`). 라이브 키가 하나라도 있으면 화면도 API(`api/admin/billing-lab`)도 없습니다 — 버튼 하나가 실제로 청구·환불하기 때문입니다. 결제 운영자(`PAYMENT_OPERATOR_USERS`)만 씁니다.

구독은 `/support`에서 Toss 테스트 카드로 먼저 만들고, 그 뒤 실험실에서 계정을 고릅니다. 버튼은 모두 실제 코드 경로를 부릅니다(`lib/billing-lab.ts`).

- **지금 갱신 청구**: `next_billing_at`을 지금으로 당기고 그 구독 하나만 `chargeDueSubscriptions`로 청구합니다. 남은 기간이 있으면 그 뒤에 이어 붙는 조기 갱신이 됩니다.
- **Toss 응답 고르기**: `TossPayments-Test-Code` 헤더로 Toss가 지정한 오류를 돌려주게 합니다. 4xx(`REJECT_CARD_PAYMENT` 등)는 실패로 세고, 5xx(`FAILED_CARD_COMPANY`)는 결과 불분명으로 `pending`에 남습니다. 헤더는 실험실 동작 안에서, 테스트 키로 부를 때만 붙습니다.
- **기간을 지금 끝내기 / 유예 기간 지난 뒤로**: 구독의 `current_period_end`·`next_billing_at`과 `supporter_until`을 옮겨, 며칠 기다리지 않고 재시도와 `past_due` 전환을 봅니다.
- **대사 / 환불 / 웹훅**: 결제 행마다 `reconcilePayment`, `refundPayment`(정책 무시), `PAYMENT_STATUS_CHANGED` 웹훅 재생을 실행합니다.
- **Toss에서 빌링키 삭제 + BILLING_DELETED**: 키를 Toss에서 지운 뒤 한 번 더 지워 보고(Toss가 없는 키에 어떻게 답하는지 — `alreadyGone`이 기대는 응답), `BILLING_DELETED` 웹훅을 실제 핸들러로 보냅니다.
- **빌링키 삭제 대기열 처리**: 재시도 간격을 무시하고 대기열을 한 번 처리합니다.

동작마다 그 동작이 부른 Toss API 호출(메서드·경로·Test-Code·상태·요청/응답 본문, 빌링키는 가림)과, 구독·계정·결제 원장·삭제 대기열의 변경 전/후(바뀐 칸 노랑, 새 행 초록)를 보여 줍니다.

## Toss 웹훅 등록

웹훅은 [개발자센터](https://developers.tosspayments.com/my/webhooks)에서 **MID마다** 따로 등록합니다. URL은 둘 다 `https://<도메인>/api/webhooks/toss`입니다.

| MID | 이벤트 | 하는 일 |
| --- | --- | --- |
| 자동결제(빌링) | `PAYMENT_STATUS_CHANGED` | 대시보드·카드사에서 일어난 취소(`CANCELED`/`PARTIAL_CANCELED`)를 바로 원장과 이용 기간에 반영합니다. 자동결제 승인 완료에는 오지 않습니다. |
| 자동결제(빌링) | `BILLING_DELETED` | 나루 밖에서 지워진 빌링키의 구독을 취소합니다. 나루가 지운 키에도 오지만, 그때는 이미 비워진 키라 할 일이 없습니다. |
| 한 번만 결제 | `PAYMENT_STATUS_CHANGED` | 취소 반영과 함께, 승인되지 않고 끝난 결제(`ABORTED`/`EXPIRED`)를 대기 상태에서 정리합니다. |

나머지 이벤트는 등록하지 않습니다. `DEPOSIT_CALLBACK`은 가상계좌, `CANCEL_STATUS_CHANGED`는 비동기 해외 간편결제 전용이라 카드만 받는 나루에는 오지 않고, 브랜드페이·링크페이·지급대행 이벤트도 쓰지 않습니다. 받더라도 무시합니다. 웹훅은 10초 안에 2xx를 받지 못하면 최대 7회(약 3일 19시간) 재전송되며, 처리 중 일시적인 오류에는 503을 돌려 재전송을 받습니다.

## 데이터 모델

결제 표(`subscriptions`, `payments`, `payment_events`, `toss_webhook_deliveries`, `retired_billing_keys`)의 기본키는 UUIDv7입니다(`uuid_v7()`, 마이그레이션에서 정의). 이후 `1790824144110`에서 `users`를 비롯해 다른 모든 일련번호 기본키도 UUIDv7로 바뀌었습니다. 주소나 화면에 드러나도 결제가 몇 건인지 알려 주거나 차례로 넘겨 볼 수 없고, 만든 순서대로 정렬됩니다 — 같은 밀리초 안에서도(밀리초 아래 12비트에 시각을 넣는 RFC 9562 방식 3). 청구 코드는 이 순서에 기댑니다(가장 최근 시도, 가장 오래된 이벤트). 정기 결제의 시도 키(`subscription:<구독 id>:…`, `subscription_initial:<구독 id>:…`)에도 구독 id가 들어갑니다. `user_id`도 이제 UUIDv7입니다.

- `users.supporter_comp` / `users.supporter_until` / `users.toss_customer_key`
- `subscriptions`: 사용자당 한 행. `plan`, `billing_interval`, `amount`, `status`(`incomplete`/`active`/`past_due`/`canceled`), `toss_billing_key`(서버 전용), 기간 필드.
- `retired_billing_keys`: Toss에서 아직 지우지 못한 옛 빌링키 대기열. 삭제가 확인되면 행이 사라집니다.
- `payment_events`: 결제·정기 결제 이벤트와 운영자 메일 발송 시각(`emailed_at`).
- `toss_webhook_deliveries`: 받은 웹훅과 처리 결과.
- `payments`: Toss 청구 시도/성공 원장. `refunded_amount`, `refunded_at`은 Toss에서 확인한 누적 환불 정보이고, `last_reconciled_at`, `reconciliation_error`는 최근 대사 진단입니다.
- `supporter_feature_uses`: `(user_id, feature)`가 기본키. 유료 기능을 언제 처음/마지막으로 썼는지만 남기는 표로, 환불 조건 판정에 씁니다.

## 환경 변수

자동결제(빌링)와 한 번만 결제는 서로 다른 MID로 계약되어 있어 키도 둘입니다.

- `TOSS_BILLING_CLIENT_KEY` / `TOSS_PAYMENT_CLIENT_KEY`: 서버에서 읽어 클라이언트로 전달하는 공개 키.
- `TOSS_BILLING_SECRET_KEY` / `TOSS_PAYMENT_SECRET_KEY`: 서버 전용 시크릿 키.
- `RESEND_API_KEY` / `FROM_EMAIL` / `BASE_URL`: 결제 갱신/실패 안내 메일 발송에 사용합니다.

개발/테스트에는 Toss 테스트 키를 사용하세요.

## 테스트

- `pnpm test:payments`: DB 없이 도는 결제 단위 테스트.
- `pnpm test:payments:db`: 새 로컬 PostgreSQL 클러스터를 띄워 최신 스키마로 마이그레이션한 뒤, 기간 부여·청구 리스·갱신 cron·환불 대사를 실제 트랜잭션으로 확인합니다. `initdb`는 root로 실행할 수 없으니 일반 사용자로 실행하세요. 가입(prepare/confirm) 흐름의 경합도 여기서 확인합니다.
