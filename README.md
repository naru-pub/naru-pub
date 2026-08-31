# 나루 (Naru)

> 당신의 공간이 되는, 나루.

나루는 개인 웹사이트 호스팅 플랫폼으로, 사용자에게 1GB의 저장 공간을 제공하여 자신만의 갠홈페이지를 만들고 관리할 수 있게 해주는 서비스입니다.

## 🚀 주요 기능

- **개인 웹사이트 호스팅**: 사용자별 서브도메인을 통한 개인 웹사이트 제공
- **파일 관리**: 웹 기반 파일 브라우저를 통한 파일 업로드, 편집, 삭제
- **실시간 편집**: CodeMirror 기반의 실시간 코드 편집기
- **다양한 파일 형식 지원**: HTML, CSS, JavaScript, JSON, Markdown 등
- **사용자 인증**: Lucia Auth를 통한 안전한 사용자 인증 시스템
- **통계 대시보드**: 서비스 사용 현황 및 지표 모니터링
- **커스텀 도메인**: 후원자 도메인을 Cloudflare for SaaS + Tunnel 프록시로 라우팅
- **후원(결제)**: Toss Payments 자동결제로 운영을 지탱하는 후원 모델

## 🏗️ 아키텍처

나루는 두 개의 주요 컴포넌트로 구성됩니다:

### 1. Control Plane (Next.js)

- **위치**: `control-plane/`
- **기술 스택**: Next.js, React, TypeScript, Tailwind CSS
- **주요 기능**:
  - 사용자 인증 및 계정 관리
  - 웹 기반 파일 브라우저
  - 실시간 코드 편집기
  - 관리자 대시보드

### 2. Proxy Server (Rust)

- **위치**: `proxy/`
- **기술 스택**: Rust, Tokio, Hyper
- **주요 기능**:
  - Cloudflare R2 스토리지 프록시
  - 서브도메인 및 커스텀 도메인 기반 라우팅
  - 정적 파일 서빙

## 📚 문서

- [사이트 데이터베이스](docs/database.md) — JSON 문서 저장소, 공개/관리자 권한, 웹 SDK

- [개발 환경 설정](docs/development.md) — 설치, 환경 변수, 실행, 프로젝트 구조, 테스트, 스크립트
- [커스텀 도메인](docs/custom-domains.md) — Cloudflare for SaaS + Tunnel, catch-all 라우트, 인증 자동 폴링
- [후원과 결제](docs/billing.md) — 시간 기반 엔티틀먼트와 Toss Payments 자동결제
- [GitHub CI Deploys](docs/github-ci.md) — GitHub Actions OIDC 기반 배포 연동
- [기여하기](docs/contributing.md)

## 📄 라이선스

이 프로젝트는 [GNU Affero General Public License v3.0](LICENSE) 하에 배포됩니다.

## 📞 문의

- **트위터**: [@naru_pub](https://x.com/naru_pub)
- **이슈**: [GitHub Issues](https://github.com/your-username/naru-pub/issues)

## 🙏 감사의 말

나루는 다음과 같은 오픈소스 프로젝트들에 의존하고 있습니다:

- [Next.js](https://nextjs.org/) - React 프레임워크
- [Lucia Auth](https://lucia-auth.com/) - 인증 라이브러리
- [CodeMirror](https://codemirror.net/) - 코드 에디터
- [Tailwind CSS](https://tailwindcss.com/) - CSS 프레임워크
- [Kysely](https://kysely.dev/) - TypeScript SQL 쿼리 빌더

---

**즐거운 코딩 되세요! 🚀**
