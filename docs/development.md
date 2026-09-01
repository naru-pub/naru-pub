# 개발 환경 설정

## 사전 요구사항

- **Node.js** 18+
- **Rust** 1.70+
- **PostgreSQL** 15+
- **Cloudflare R2** 계정 (또는 AWS S3)

## 1. 저장소 클론

```bash
git clone https://github.com/your-username/naru-pub.git
cd naru-pub
```

## 2. Control Plane 설정

```bash
cd control-plane

# 의존성 설치 (pnpm 사용; npm 사용 금지)
pnpm install

# 환경 변수 설정
cp .env.template .env
```

`.env` 파일을 편집하여 다음 환경 변수들을 설정하세요:

```env
# 데이터베이스
DATABASE_URL=postgresql://username:password@localhost:5432/naru

# S3/R2 설정
S3_BUCKET_NAME=your-bucket-name
SITE_DATA_MEDIA_BUCKET=naru-media
SITE_DATA_MEDIA_ORIGIN=https://media.naru.pub
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key

# 기타
NEXT_PUBLIC_DOMAIN=naru.pub
FEATURE_ACCESS_MODE=preview
CUSTOM_DOMAIN_CNAME_TARGET=custom-domains.naru.pub
CLOUDFLARE_ZONE_ID=your-cloudflare-zone-id
CLOUDFLARE_USER_API_TOKEN=your-cloudflare-api-token

# Toss Payments (후원/결제) — 테스트 키 사용
TOSS_CLIENT_KEY=your-toss-client-key
TOSS_SECRET_KEY=your-toss-secret-key
```

`naru-media`에는 `media.naru.pub` 공개 커스텀 도메인을 연결하세요. 객체 쓰기는
서명된 R2 API URL로만 허용합니다. 브라우저가 직접 업로드할 수 있도록 버킷 CORS에서
웹사이트 출처의 `PUT`과 `Content-Type` 헤더를 허용해야 합니다. R2 API 토큰에는
`naru-media`의 객체 읽기·쓰기 권한도 필요합니다.

`preview` 모드에서는 `users.supporter_comp`가 설정된 계정만 커스텀 도메인,
분석, 데이터베이스를 사용할 수 있습니다. 이 기능을 후원자에게 공개할 때는
`FEATURE_ACCESS_MODE=supporters`로 바꾸면 기존 후원자 권한과 결제 유예 기간을
사용합니다.

## 3. 데이터베이스 설정

```bash
# 데이터베이스 마이그레이션 실행
pnpm migrate

# 타입 생성 (선택사항)
pnpm kysely-codegen
```

## 4. Proxy Server 설정

```bash
cd ../proxy

# 의존성 설치
cargo build

# 환경 변수 설정
export R2_BUCKET_NAME=your-bucket-name
export R2_ACCOUNT_ID=your-cloudflare-account-id
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export PORT=5000
export PLATFORM_DOMAIN=naru.pub
export R2_PUBLIC_DOMAIN=r2.naru.pub
```

> 커스텀 도메인 운영 설정(Cloudflare for SaaS, Tunnel catch-all)은 [커스텀 도메인](custom-domains.md)을, 후원/결제 설정은 [후원과 결제](billing.md)를 참고하세요.

## 5. 개발 서버 실행

**Control Plane:**

```bash
cd control-plane
pnpm dev
```

**Proxy Server:**

```bash
cd proxy
cargo run
```

이제 다음 주소에서 서비스에 접근할 수 있습니다:

- Control Plane: http://localhost:3000
- Proxy Server: http://localhost:5000

## 프로젝트 구조

```
naru-pub/
├── control-plane/          # Next.js 웹 애플리케이션
│   ├── src/
│   │   ├── app/           # Next.js App Router
│   │   ├── components/    # React 컴포넌트
│   │   ├── lib/          # 유틸리티 및 설정
│   │   └── migrations/   # 데이터베이스 마이그레이션
│   └── package.json
├── proxy/                 # Rust 프록시 서버
│   ├── src/
│   │   └── main.rs       # 메인 서버 로직
│   └── Cargo.toml
├── docs/                  # 문서
└── README.md
```

## 테스트

```bash
# Control Plane 테스트
cd control-plane
pnpm test

# E2E 테스트 (Playwright)
pnpm exec playwright test
```

## 사용 가능한 스크립트

### Control Plane

```bash
pnpm dev                  # 개발 서버 실행
pnpm build                # 프로덕션 빌드
pnpm start                # 프로덕션 서버 실행
pnpm lint                 # 코드 린팅
pnpm migrate              # 데이터베이스 마이그레이션
pnpm kysely-codegen       # 데이터베이스 타입 생성
pnpm charge-subscriptions # 구독 자동 갱신 청구 (cron이 매일 실행)
```

### Proxy

```bash
cargo build               # 빌드
cargo run                 # 실행
cargo test                # 테스트
```
