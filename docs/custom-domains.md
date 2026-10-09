# 커스텀 도메인 (Cloudflare for SaaS + 엣지 Worker)

제3자 도메인은 우리 Cloudflare 계정의 zone이 아니므로, Cloudflare for SaaS의 Custom Hostnames가 TLS와 호스트 수락을 담당합니다. 커스텀 도메인 요청은 원래 호스트명(예: `limeburst.net`)으로 `naru.pub` zone에 들어오고, zone의 `*/*` Worker 라우트가 이를 엣지 Worker(`naru-edge`, `edge/`)로 보냅니다. Worker는 `Host` 헤더를 control plane이 보낸 커스텀 도메인 표에서 찾아 사용자 사이트를 R2에서 바로 서빙합니다. 표에 없는 호스트는 404입니다. 라우트 구성은 [배포 문서](deployment.md#hosted-sites-at-the-edge)를 참고하세요.

운영 시 필요한 설정:

- Cloudflare for SaaS fallback origin: Cloudflare for SaaS가 요구하므로 레코드는 있어야 하지만, Worker가 먼저 요청을 받으므로 트래픽이 실제로 도달하지는 않습니다.
- `CUSTOM_DOMAIN_CNAME_TARGET`: 사용자가 DNS에 설정할 CNAME/ALIAS 대상입니다. Cloudflare for SaaS CNAME target으로 설정해야 합니다. 예: `customers.naru.pub`
- `CLOUDFLARE_USER_API_TOKEN`: Custom Hostnames를 생성/조회/삭제할 API 토큰입니다. Cloudflare의 `SSL and Certificates Write` 권한이 필요합니다.
- `EDGE_WORKER_URL`, `EDGE_WORKER_SECRET`: control plane이 Worker에 커스텀 도메인 표를 보낼 때 씁니다([배포 문서](deployment.md#edge-worker) 참고).

유료 기능 활성화는 시간 기반 엔티틀먼트로 제어됩니다([유료 서비스와 결제](billing.md) 참고). 사용자가 계정 페이지에서 도메인을 등록하면 control-plane이 Cloudflare Custom Hostname을 생성하고, 사용자는 Cloudflare가 반환한 소유권/인증서 검증 레코드를 DNS에 추가합니다. 엣지는 `cloudflare_status = 'active'`, `ssl_status = 'active'`, `verified_at IS NOT NULL`이고 소유자가 유료 이용자(`supporter_comp` 또는 `supporter_until + PAYMENT_GRACE_DAYS > now()`)인 커스텀 도메인만 서빙합니다.

## 엣지의 커스텀 도메인 표

control plane(`control-plane/src/lib/edge/domains.ts`)은 위 조건을 만족하는 도메인 전체를 로그인 이름과 엔티틀먼트가 끝나는 시각(`entitledUntil`)에 매핑해 내부 API `/v1/domains/replace`로 Worker에 보냅니다. Worker는 이 표를 KV(`DOMAINS` 바인딩, 항목 하나)에 두고 `confirmedUntil`까지, 즉 마지막으로 받은 뒤 3일 동안 서빙합니다. `site-data-edge-sync` 작업이 5분마다 표를 다시 보내고, 도메인이 활성화되거나 삭제되면 곧바로 보냅니다. 그래서 control plane이 멈춰도 커스텀 도메인은 최대 3일 동안 계속 응답합니다.

Worker가 원본보다 먼저 커스텀 호스트명을 가로채므로, 예전 Rust 서버 시절에 필요했던 Tunnel ingress catch-all 규칙(커스텀 도메인을 `localhost:40001`로 보내던 것)은 더 이상 필요하지 않습니다.

## 인증 상태 자동 폴링

도메인 추가 직후에는 DNS 전파와 Cloudflare DCV가 끝나지 않아 `cloudflare_status`/`ssl_status`가 `pending`입니다. cron 컨테이너의 `refresh-custom-domains.ts`가 **3분마다** 아직 활성화되지 않은 커스텀 도메인을 Cloudflare에서 조회해 상태를 갱신하므로, 사용자가 계정 페이지로 돌아와 상태 확인 버튼을 누르지 않아도 검증이 끝나면 자동으로 서빙이 시작됩니다. 계정 페이지의 상태 확인 버튼은 즉시 확인용으로 남아 있습니다.

- 이미 `active`인 도메인은 쿼리에서 제외되어 다시 폴링하지 않습니다.
- 생성된 지 14일이 지난 도메인은 자동 폴링 대상에서 빠지며, 필요하면 수동 버튼으로 갱신할 수 있습니다(방치/오설정 도메인에 대한 무한 폴링 방지).
- Cloudflare 상태 조회는 무료 API 호출이며 과금되지 않습니다. SaaS 비용은 폴링 빈도와 무관하게 활성 custom hostname 개수에만 부과됩니다.

## 만료 후 회수

결제 기간과 결제 유예 기간이 모두 끝나면 cron 컨테이너의 `cleanup-expired-custom-domains.ts`가 Cloudflare for SaaS Custom Hostname을 삭제하고 `custom_domains` 행도 제거합니다. 영구 제공 계정(`supporter_comp`)은 이 회수 대상에서 제외됩니다.
