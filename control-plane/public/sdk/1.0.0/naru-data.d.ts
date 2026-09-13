/**
 * 나루 데이터 브라우저 SDK의 타입 선언입니다.
 *
 * SDK는 이 선언과 함께 제공되는 ES 모듈 하나입니다. 정적 웹페이지에 그대로
 * 불러다 쓰면 되고, 빌드 과정이나 번들러, 패키지 설치가 필요 없습니다.
 * 데이터베이스와 컬렉션은 제어판(`/database`)에서 만들고, 페이지에서는 이름으로
 * 부르기만 합니다.
 *
 * ```html
 * <script type="module">
 *   import { collection } from "https://naru.pub/sdk/1.0.0/naru-data.js";
 *   const { documents } = await collection("posts").list({ limit: 20 });
 * </script>
 * ```
 *
 * `내-로그인-이름.naru.pub`에 올린 페이지는 사이트를 주소에서 알아냅니다. 연결한
 * 도메인이나 로컬 개발에서는 `{ site: "내-로그인-이름" }`을 함께 넘기세요.
 *
 * 1.0.0은 아직 개발 중이며 `no-cache`로 제공되므로, 고정된 주소가 아니라
 * 바뀔 수 있는 주소로 다루세요. 기능은 필요해질 때 더합니다.
 *
 * @packageDocumentation
 */

/** JSON으로 오갈 수 있는 값입니다. 날짜는 문자열로 바꿔 저장하세요. */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/** 저장된 문서 하나와 서버 메타데이터입니다. */
export interface Document<T = Json> {
  /** ASCII 영문자, 숫자, 밑줄, 하이픈 1~64자입니다. */
  id: string;
  /** 저장한 JSON입니다. 서버는 `T`를 검사하지 않습니다. */
  data: T;
  /** 서버가 매긴 ISO 8601 생성 시각이며, `set`으로 교체해도 유지됩니다. */
  createdAt: string;
  /** 가장 최근 쓰기의 ISO 8601 시각입니다. */
  updatedAt: string;
  /** 쓰기마다 증가합니다. `ifVersion`으로 되돌려 주세요. */
  version: number;
}

/** 쓰기가 반영되면 돌아오는 값입니다. 방금 저장한 것을 그릴 때 브라우저 시계
 * 대신 이 시각을 쓰세요. */
export interface Written {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 데이터 API가 오류로 답한 요청입니다.
 *
 * 연결이 끊긴 요청은 `fetch`의 `TypeError`로, 취소한 요청은 `AbortError`로 그대로
 * 전달됩니다.
 */
export class NaruDataError extends Error {
  /** HTTP 상태 코드입니다. */
  status: number;
  /** 프로그램이 판단할 수 있는 실패 코드입니다. `VERSION_CONFLICT`,
   * `OWNER_SESSION_EXPIRED`, `COLLECTION_NOT_AUTHORIZED`,
   * `UNREGISTERED_REDIRECT_URI` 등이 있고, 분류되지 않은 실패는
   * `REQUEST_FAILED`입니다. */
  code: string;
  constructor(status: number, message: string, code?: string);
}

/** 어느 사이트의 데이터인지 정합니다. */
export interface SiteOptions {
  /** 나루 로그인 이름입니다. `이름.naru.pub`에 올린 페이지에서는 생략합니다. */
  site?: string;
  /** 개발용입니다. HTTP 루프백 출처만 받습니다. */
  controlPlaneOrigin?: string;
}

export interface RequestOptions {
  /** 취소하면 요청이 `AbortError`로 끝납니다. */
  signal?: AbortSignal;
}

/** 쓰기를, 읽어 둔 버전이 그대로일 때만 반영합니다. */
export interface Conditional {
  /** 다르면 `VERSION_CONFLICT`로 거부됩니다. `0`은 아직 없어야 한다는
   * 뜻입니다. */
  ifVersion?: number;
}

/** 범위 비교입니다. 문자열 경계는 문자열 필드와, 수 경계는 수 필드와만
 * 비교되고, 필드가 없는 문서는 빠집니다. */
export interface RangeFilter {
  gt?: string | number;
  gte?: string | number;
  lt?: string | number;
  lte?: string | number;
}

/** 최상위 필드 조건을 최대 5개까지 AND로 묶습니다. 값은 정확히 같은지를,
 * 비교 객체는 범위를 봅니다. `{}`는 거르지 않는다는 뜻입니다. 주소에 실려 가므로
 * 비밀 값으로 거르지 마세요. */
export type Filter = Record<
  string,
  string | number | boolean | null | RangeFilter
>;

/** 한두 개의 `[필드, 방향]`입니다. 필드는 `createdAt`, `updatedAt`,
 * `data.<최상위 필드>`이고, 문서 ID가 마지막 기준으로 자동으로 붙습니다. ID만으로
 * 정렬하려면 `[["id", "desc"]]`처럼 혼자 쓰세요. 생략하면 ID 오름차순입니다. */
export type OrderBy =
  | [[string, "asc" | "desc"]]
  | [[string, "asc" | "desc"], [string, "asc" | "desc"]];

/** 한 쪽을 읽는 조건입니다. */
export interface ListOptions extends RequestOptions {
  where?: Filter;
  orderBy?: OrderBy;
  /** 기본 50, 최대 100입니다. */
  limit?: number;
  /** 앞 쪽의 `nextPageToken`을 그대로 넘기세요. `null`이면 첫 쪽입니다. 같은
   * `where`와 `orderBy`에서만 쓸 수 있습니다. */
  pageToken?: string | null;
  /** 참이면 조건에 맞는 전체 개수를 `total`에 함께 받습니다. */
  includeTotal?: boolean;
}

/** 컬렉션 하나의 한 쪽입니다. */
export interface Page<T> {
  documents: Document<T>[];
  /** 마지막 쪽이면 `null`입니다. */
  nextPageToken: string | null;
  /** `includeTotal`을 넘겼을 때만 있습니다. */
  total?: number;
}

/**
 * 컬렉션 하나입니다. 만드는 것만으로는 요청이 일어나지 않습니다.
 *
 * 이 브라우저가 쓴 컬렉션은 10초 동안 캐시를 건너뛰고 읽으므로, 방금 쓴 것이
 * 곧바로 목록에 보입니다.
 */
export interface Collection<T = Json> {
  /** @throws 문서가 없으면 `status: 404`. */
  get(id: string, options?: RequestOptions): Promise<Document<T>>;
  /**
   * ```js
   * let pageToken = null;
   * do {
   *   const page = await posts.list({ limit: 20, pageToken });
   *   render(page.documents);
   *   pageToken = page.nextPageToken;
   * } while (pageToken);
   * ```
   */
  list(options?: ListOptions): Promise<Page<T>>;
  /** 서버가 매긴 UUID로 새 문서를 만듭니다. 읽기 권한이 없어도 됩니다. */
  add(data: T, options?: RequestOptions): Promise<Written>;
  /** 문서 전체를 교체하거나 새로 만듭니다. */
  set(
    id: string,
    data: T,
    options?: RequestOptions & Conditional,
  ): Promise<Written>;
  /** 없는 문서를 지워도 성공합니다. */
  delete(id: string, options?: RequestOptions & Conditional): Promise<void>;
}

/**
 * 사이트의 컬렉션 하나를 가리킵니다.
 *
 * ```js
 * const guestbook = collection("guestbook");
 * await guestbook.add({ name: "방문자", message: "안녕하세요" });
 * ```
 *
 * @throws 사이트를 알 수 없거나 이름이 올바르지 않으면 TypeError.
 */
export function collection<T = Json>(
  name: string,
  options?: SiteOptions,
): Collection<T>;

/** 미디어 라이브러리에 있는 파일입니다. */
export interface StoredFile {
  id: string;
  /** 원래 파일 이름입니다. 줄인 사진은 확장자가 바뀝니다. */
  name: string;
  contentType: string;
  size: number;
  status: "ready";
  /** `media.naru.pub`의 공개 주소입니다. 문서에는 이 주소를 저장하세요. */
  url: string;
  /** 올릴 때 넘긴 값입니다. */
  metadata: Json;
  createdAt: string;
  updatedAt: string;
}

/** `add`와 `set`은 쓰기 결과를, `delete`는 `{ success: true }`를 돌려줍니다. */
export type BatchOperation =
  | { type: "add"; collection: string; data: Json }
  | ({ type: "set"; collection: string; id: string; data: Json } & Conditional)
  | ({ type: "delete"; collection: string; id: string } & Conditional);

/** `ownerSession()`이 돌려주는, 사이트 관리자로 인증된 클라이언트입니다.
 *
 * 로그인할 때 고른 컬렉션까지만 닿습니다. 토큰은 이 탭의 `sessionStorage`에 있고
 * 같은 페이지의 스크립트가 읽을 수 있으니, 편집 페이지에는 외부 스크립트를 두지
 * 마세요. */
export interface Owner {
  /** 세션이 끝나는 유닉스 밀리초입니다(최대 24시간). 이 시각이 지나거나 서버가
   * 401로 답하면 요청은 `OWNER_SESSION_EXPIRED`로 실패하고, 다음
   * `ownerSession()`은 null을 돌려줍니다. */
  readonly expiresAt: number;
  collection<T = Json>(name: string): Collection<T>;
  /**
   * 전부 반영하거나 전부 되돌립니다. 결과는 넘긴 순서대로입니다.
   *
   * ```js
   * await owner.batch([
   *   { type: "set", collection: "posts", id: "hello", data: post },
   *   { type: "delete", collection: "drafts", id: "hello" },
   * ]);
   * ```
   */
  batch(
    operations: BatchOperation[],
    options?: RequestOptions,
  ): Promise<(Written | { success: true })[]>;
  files: {
    /** 최근에 올린 것부터 한 쪽씩 가져옵니다. `where`는 `metadata`의 최상위
     * 필드를 거릅니다. */
    list(
      options?: RequestOptions & {
        where?: Filter;
        limit?: number;
        pageToken?: string | null;
      },
    ): Promise<{ files: StoredFile[]; nextPageToken: string | null }>;
    /**
     * 파일 하나를 올립니다. 바이트는 나루를 거치지 않고 저장소로 바로 갑니다.
     *
     * JPEG·PNG·WebP·HEIC 사진은 긴 변이 2048px를 넘거나 512 KiB보다 무거우면
     * 올리기 전에 브라우저에서 줄여 WebP(안 되면 JPEG)로 다시 저장합니다. 이때
     * 촬영 위치 같은 EXIF는 사라지고 회전은 픽셀에 반영됩니다. 파일 하나는 줄인
     * 뒤 25 MiB까지입니다. HTML과 SVG는 받지 않습니다.
     *
     * ```js
     * const image = await owner.files.upload(input.files[0], {
     *   metadata: { postId: "hello" },
     * });
     * ```
     */
    upload(
      file: File | Blob,
      options?: RequestOptions & {
        /** 나중에 `list({ where })`로 찾을 값입니다. 최대 8 KiB입니다. */
        metadata?: { [key: string]: Json };
      },
    ): Promise<StoredFile>;
    /** 파일을 지웁니다. 이 주소를 쓰는 문서는 그대로 남습니다. */
    delete(id: string, options?: RequestOptions): Promise<void>;
  };
  /** 이 탭의 세션을 지운 뒤 서버에 폐기를 요청합니다. 연결이 끊겨 있으면 폐기
   * 요청은 실패할 수 있습니다. */
  signOut(): Promise<void>;
}

/**
 * 나루로 이동해 관리자가 `collections`에 대한 접근을 승인하고, 이 페이지로
 * 돌아옵니다. 이 페이지의 주소(질의 문자열 제외)를 제어판에 관리자 콜백으로
 * 먼저 등록하세요. 페이지를 떠나므로 이 호출 뒤의 코드는 실행되지 않습니다.
 *
 * @throws 등록하지 않은 페이지이면 `UNREGISTERED_REDIRECT_URI`.
 */
export function signIn(
  options: SiteOptions & { collections: string[] },
): Promise<void>;

/**
 * 이 페이지의 관리자 클라이언트이거나 null입니다.
 *
 * 나루에서 막 돌아왔으면 로그인을 마무리하고, 아니면 이 탭의 세션을 되살립니다.
 * 주소에서 일회용 코드를 지우므로 화면을 그리기 전에 부르세요.
 *
 * ```js
 * const owner = await ownerSession();
 * if (owner) await owner.collection("posts").set("hello", { title: "안녕" });
 * else await signIn({ collections: ["posts"] });
 * ```
 */
export function ownerSession(options?: SiteOptions): Promise<Owner | null>;
