# 비둘기 둥지

스케치의 프로필, 가로형 최근 글 카드, 월간 달력, 카테고리 색상, 글쓰기 화면을 구현한 Naru 데이터베이스 블로그입니다.

## 데이터베이스 설정

1. https://naru.pub/database 에서 다음 컬렉션을 만드세요.
   - `posts`: 읽기 `world`, 쓰기 `admin`
   - `categories`: 읽기 `world`, 쓰기 `admin`
   - `site`: 읽기 `world`, 쓰기 `admin`
   - `guestbook`: 읽기 `world`, 쓰기 `create`
2. 웹사이트 관리자 로그인에 실제 `index.html` 주소를 등록하고 `posts`, `categories`, `site`, `guestbook` 컬렉션을 허용하세요.
3. `config.js`의 `site` 값은 이미 `eyecntct`로 설정되어 있습니다. Client ID는 등록된 현재 URL을 사용해 자동으로 찾습니다.
4. 이 폴더의 파일을 사이트 루트에 업로드하세요.

프로필을 바꾸려면 `site` 컬렉션의 `profile` 문서를 만들고 `name`, `handle`, `intro` 값을 저장하세요. 글 편집기에서 선택한 이미지는 SDK 1.0.0을 통해 Naru Media에 업로드되고 문서에는 공개 URL만 저장됩니다.

본문은 `bodyMarkdown`에 저장됩니다. 이미지 업로드가 끝나면 `![파일명](https://media.naru.pub/...)` 마크다운이 현재 커서 위치에 추가됩니다.

카테고리는 하드코딩하지 않습니다. `categories` 컬렉션의 각 문서가 `name`과 `color`를 가지며, 글은 `categoryId`로 해당 문서를 참조합니다. 새 카테고리는 글 편집기에서 만들 수 있습니다. 관리자로 로그인하면 기존 글의 `category`와 `categoryColor` 값을 카테고리 문서로 옮기고 글에는 `categoryId`만 남깁니다. 색상은 유효한 6자리 대문자 hex 값으로 정규화됩니다.

최근 글 위의 카테고리 필터는 브라우저에서 전체 글을 순회하지 않고 `where: { categoryId }`를 Naru 데이터베이스에 전달합니다. 선택한 카테고리의 글만 서버에서 페이지 단위로 받아 최근 글과 달력에 함께 표시합니다.
