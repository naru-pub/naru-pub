# 기여하기

나루 프로젝트에 기여하고 싶으시다면 다음과 같은 방법들이 있습니다:

## 1. 이슈 리포트

- 버그 발견 시 [GitHub Issues](https://github.com/your-username/naru-pub/issues)에 리포트
- 새로운 기능 제안도 환영합니다

## 2. 코드 기여

1. 이 저장소를 포크합니다
2. 새로운 브랜치를 생성합니다 (`git checkout -b feature/amazing-feature`)
3. 변경사항을 커밋합니다 (`git commit -m 'Add amazing feature'`)
4. 브랜치에 푸시합니다 (`git push origin feature/amazing-feature`)
5. Pull Request를 생성합니다

## 3. 개발 가이드라인

- TypeScript/JavaScript 코드는 ESLint 규칙을 따릅니다
- 엣지 Worker(`edge/`)를 바꾸면 `cd edge && pnpm test`를 통과해야 합니다
- 새로운 기능은 테스트 코드를 포함해야 합니다
- 커밋 메시지는 명확하고 설명적이어야 합니다
