/**
 * 나루 데이터 브라우저 SDK의 타입 선언입니다.
 *
 * SDK는 이 선언과 함께 제공되는 ES 모듈 하나입니다. 정적 웹페이지에 그대로
 * 불러다 쓰면 되고, 빌드 과정이나 번들러, 패키지 설치가 필요 없습니다.
 *
 * ```html
 * <script type="module">
 *   import { createDatabase } from "https://naru.pub/sdk/1.0.0/naru-data.js";
 *   const db = createDatabase({ site: "내-로그인-이름" });
 *   const { documents } = await db.collection("posts").list({ limit: 20 });
 * </script>
 * ```
 *
 * 모든 작업은 나루 제어판으로 보내는 HTTPS 요청 한 번입니다. 공개된 읽기와
 * 쓰기에는 인증이 필요 없고, 컬렉션이 관리자 전용으로 정한 작업에는
 * `completeOwnerSignIn()`이 돌려주는 관리자 클라이언트가 필요합니다.
 *
 * 1.0.0은 아직 개발 중이며 `no-cache`로 제공되므로, 고정된 주소가 아니라
 * 바뀔 수 있는 주소로 다루세요.
 *
 * @packageDocumentation
 */

/**
 * JSON으로 오갈 수 있는 모든 값입니다.
 *
 * `JSON.stringify`가 조용히 버리거나 바꿔 버리는 값은 쓰기에서 거부됩니다.
 * `undefined`, 유한하지 않은 수, `BigInt`, 함수, 심볼, 순환 참조, 구멍 난 배열,
 * getter, 열거되지 않는 속성, 클래스 인스턴스가 여기 해당합니다. 날짜는 직접
 * 문자열로 바꾸세요. `Date`도 클래스 인스턴스여서 거부됩니다.
 *
 * 저장된 값은 PostgreSQL JSONB 규칙을 따릅니다. 객체 키 순서는 보존되지 않고,
 * 수는 자바스크립트의 정밀도를 그대로 가집니다.
 */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/** 저장된 문서 하나와, 그 문서를 따라다니는 서버 메타데이터입니다. */
export interface Document<T = Json> {
  /** ASCII 영문자, 숫자, 밑줄, 하이픈 1~64자입니다. */
  id: string;
  /** 저장한 JSON입니다. `T`는 선언일 뿐 검증된 형태가 아닙니다. */
  data: T;
  /** 서버가 매기는 ISO 8601 생성 시각이며, `set`으로 교체해도 유지됩니다. */
  created_at: string;
  /** 가장 최근에 반영된 쓰기의 ISO 8601 시각입니다. */
  updated_at: string;
  /** 쓰기가 반영될 때마다 증가합니다. `ifVersion`으로 되돌려 주세요. */
  version: number;
  /** 서버가 채우는 자리입니다. 직접 쓴 문서에는 `{}`가 들어 있습니다. */
  metadata: Json;
}

/** 쓰기가 성공했을 때 돌아오는 값입니다. */
export interface Written {
  /** 직접 정한 문서 ID이거나, `add`가 매긴 UUID입니다. */
  id: string;
  /** 이 쓰기가 만든 버전입니다. 새로 만든 문서는 `1`입니다. */
  version: number;
}

/** 문서 하나를 쓰는 모든 작업에 섞어 쓰는 낙관적 동시성 제어입니다. */
export interface Conditional {
  /** 저장된 버전이 그대로일 때만 쓰고, 아니면 `VERSION_CONFLICT`
   * NaruDataError로 거부합니다. `0`은 문서가 아직 없어야 한다는 뜻입니다. */
  ifVersion?: number;
}

/**
 * 호출하는 쪽의 실수가 아닌 모든 실패입니다.
 *
 * 잘못된 ID, JSON으로 표현할 수 없는 값처럼 호출하는 쪽의 실수는 요청을 보내기
 * 전에 `TypeError`로 알립니다. 네트워크까지 간 실패는 이 오류로 전달됩니다.
 *
 * ```js
 * try {
 *   await db.collection("posts").get("missing");
 * } catch (error) {
 *   if (error instanceof NaruDataError && error.status === 404) show("글 없음");
 *   else throw error;
 * }
 * ```
 */
export class NaruDataError extends Error {
  /** HTTP 상태 코드이며, 응답을 받지 못했으면 0입니다. */
  status: number;
  /** 프로그램이 판단할 수 있는 고정된 실패 코드입니다. `VERSION_CONFLICT`,
   * `OWNER_SESSION_EXPIRED`, `COLLECTION_NOT_AUTHORIZED`,
   * `UNREGISTERED_REDIRECT_URI` 등이 있고, 분류되지 않은 실패는
   * `REQUEST_FAILED`입니다. */
  code: string;
  /** 원인이 된 네트워크 오류나 파싱 오류입니다. */
  cause?: unknown;
  constructor(status: number, message: string, code?: string);
}

/** 범위 비교는 JSONB 타입 안에서만 이루어집니다. 문자열 경계는 수 필드와 절대
 * 맞지 않고, 그 필드가 없는 문서는 결과에서 빠집니다. */
export interface RangeFilter {
  /** 초과. */
  gt?: string | number;
  /** 이상. */
  gte?: string | number;
  /** 미만. */
  lt?: string | number;
  /** 이하. */
  lte?: string | number;
}

/** 최상위 필드에 조건을 최대 5개까지 걸고 AND로 묶습니다. 스칼라 값은 정확히
 * 같은지 보고, 비교 객체는 범위를 봅니다. 한 필드의 두 경계는 타입이 같아야
 * 합니다.
 *
 * 같은지 보는 기준은 엄격합니다. `1`은 `"1"`과 다르고, 문자열은 대소문자를
 * 가리며, `null`은 저장된 null과 맞을 뿐 필드가 없는 문서와는 맞지 않습니다.
 * 중첩 경로, 배열 포함 여부, OR, 부분 문자열 검색은 지원하지 않습니다.
 *
 * 필터는 주소 질의 문자열에 실려 가므로, 비밀 값으로는 거르지 마세요.
 *
 * ```js
 * // 올해 공개된 글을 최신순으로.
 * await db.collection("posts").list({
 *   where: { published: true, created_at: { gte: "2026-01-01" } },
 *   orderBy: "created_at",
 *   direction: "desc",
 * });
 * ```
 */
export type Filter = Record<
  string,
  string | number | boolean | null | RangeFilter
>;

/** `data.<필드>`는 문서의 최상위 필드로 정렬합니다. 값이 없는 필드는 JSON
 * null로 취급되어 문자열보다 아래에, 문자열은 수보다 아래에 놓입니다.
 *
 * `id`, `created_at`, `updated_at`은 서버 메타데이터로 정렬합니다. 시각이 같으면
 * 같은 방향의 ID 순으로 갈립니다. 목록에는 바뀌지 않는 `created_at`을
 * 권합니다. 넘겨보는 도중에 값이 바뀌는 필드로 정렬하면 문서가 빠지거나 두 번
 * 나올 수 있습니다. */
export type OrderBy = "id" | "created_at" | "updated_at" | `data.${string}`;

/** `list`, `all`, `count`가 함께 쓰는 거르기와 정렬 옵션입니다. */
export interface QueryOptions {
  /** 거르지 않으려면 생략하거나 `{}`를 넘기세요. */
  where?: Filter;
  /** 기본값은 `id`입니다. */
  orderBy?: OrderBy;
  /** 기본값은 `asc`입니다. */
  direction?: "asc" | "desc";
}

/** 컬렉션의 한 쪽입니다. */
export interface ListOptions extends QueryOptions {
  /** 한 쪽에 담을 문서 수로 1~100입니다. 기본값은 50입니다. */
  limit?: number;
  /** 같은 컬렉션, 같은 정렬, 같은 필터에서 받은 커서입니다. */
  after?: string;
}

/**
 * 컬렉션 하나를 가리키는 손잡이입니다. `Database.collection`에서 얻으며,
 * 손잡이를 만드는 것만으로는 요청이 일어나지 않습니다.
 *
 * `T`는 저장하려는 문서의 형태입니다. 쓰기의 타입을 잡아 주고 읽기에도 그대로
 * 적용되지만, 서버는 이를 검사하지 않습니다. `T`를 바꾸기 전에 저장한 문서는
 * 예전 형태 그대로 돌아옵니다.
 */
export interface Collection<T = Json> {
  /**
   * ID로 문서 하나를 가져옵니다.
   *
   * @throws 문서가 없으면 `status: 404`인 NaruDataError.
   */
  get(id: string): Promise<Document<T>>;
  /**
   * 한 쪽을 가져옵니다.
   *
   * 컬렉션 끝에 이르면 `nextCursor`가 `null`입니다. 그 값을 그대로 `after`로
   * 넘기되 `where`, `orderBy`, `direction`은 똑같이 유지하세요. 커서는 그것을
   * 만든 질의에 묶여 있어서, 필터가 달라지면 400으로 거부됩니다. 쪽 크기는
   * 중간에 바꿔도 됩니다.
   *
   * 넘겨보는 동안의 상태가 고정되지는 않습니다. 훑는 사이에 커서 앞쪽으로 들어온
   * 문서는 처음부터 다시 읽어야 보입니다.
   *
   * ```js
   * let after;
   * do {
   *   const page = await posts.list({ limit: 20, after });
   *   render(page.documents);
   *   after = page.nextCursor ?? undefined;
   * } while (after);
   * ```
   */
  list(
    options?: ListOptions,
  ): Promise<{ documents: Document<T>[]; nextCursor: string | null }>;
  /** 조건에 맞는 모든 문서를 필요할 때마다 한 쪽씩 가져옵니다. `limit`은 쪽
   * 크기입니다.
   *
   * 반복자가 그 쪽에 닿을 때 비로소 요청하므로, 중간에 멈추면 요청도 멈춥니다.
   *
   * ```js
   * for await (const post of posts.all({ orderBy: "created_at" })) {
   *   if (post.data.title === needle) return post;
   * }
   * ```
   */
  all(options?: Omit<ListOptions, "after">): AsyncIterableIterator<Document<T>>;
  /** 조건에 맞는 문서 수를 서버가 쪽 나눔 없이 세어 돌려줍니다. */
  count(options?: { where?: Filter }): Promise<number>;
  /**
   * 서버가 매긴 UUID로 문서를 새로 만듭니다.
   *
   * 새로 만들기만 하므로 기존 문서를 덮어쓰지 않습니다. 읽기 권한도 필요 없어서,
   * 아무도 목록을 볼 수 없는 컬렉션에도 방명록을 만들 수 있습니다.
   */
  add(data: T): Promise<Written>;
  /**
   * 문서 전체를 바꾸고, 없으면 새로 만듭니다.
   *
   * 합치기가 아니라 교체입니다. `data`에 없는 필드는 사라집니다. 문서의 일부만
   * 바꾸려면 `Collection.update`를 쓰세요. 교체해도 `created_at`은 남습니다.
   */
  set(id: string, data: T, options?: Conditional): Promise<Written>;
  /** 얕은 합치기입니다. 패치에 있는 필드가 저장된 필드를 대신하고, `unset`에
   * 적은 이름은 지워집니다. 문서가 이미 있고 JSON 객체를 담고 있어야 합니다.
   * 패치는 조각이라 문서 전체를 보는 schemas 검사기는 실행되지 않습니다.
   *
   * 합치기는 한 겹까지입니다. 패치 안의 중첩 객체는 저장된 중첩 객체에 섞이지
   * 않고 통째로 대신합니다.
   *
   * @throws 문서가 없으면 `status: 404`인 NaruDataError.
   */
  update(
    id: string,
    patch: Partial<T>,
    options?: Conditional & { unset?: (keyof T & string)[] },
  ): Promise<Written>;
  /**
   * 문서를 지웁니다.
   *
   * 여러 번 해도 같습니다. 없는 문서를 지워도 성공합니다. 이미 읽어 둔 그 문서만
   * 지우려면 `ifVersion`을 넘기세요.
   */
  delete(id: string, options?: Conditional): Promise<{ success: true }>;
}

/** `createDatabase`가 돌려주는 공개 클라이언트입니다. 인증 없이 요청하므로
 * 컬렉션의 공개 범위가 허용한 곳까지만 닿습니다. */
export interface Database {
  /** 타입은 애플리케이션의 형태를 적어 둔 것일 뿐, 읽은 값을 검증하지 않습니다. */
  collection<T = Json>(name: string): Collection<T>;
}

/** `OwnerDatabase.batch`에 담기는 작업 하나입니다. 문서 하나를 다루는 메서드와
 * 짝을 이루되 컬렉션을 작업마다 적으므로, 한 묶음이 여러 컬렉션에 걸칠 수
 * 있습니다. */
export type BatchOperation =
  /** 서버가 ID를 매기므로 id도 ifVersion도 받지 않습니다. */
  | { type: "add"; collection: string; data: Json }
  | ({ collection: string; id: string } & Conditional &
      (
        | { type: "set"; data: Json }
        | { type: "update"; data: Json; unset?: string[] }
        | { type: "delete" }
      ));

/** 사이트 미디어 라이브러리에 있는 파일입니다. */
export interface StoredFile {
  /** 서버가 매긴 ID입니다. 이 값이나 `url`을 문서에 저장하세요. */
  id: string;
  /** 원래 파일 이름이며, 이름이 없으면 `"upload"`입니다. */
  name: string;
  contentType: string;
  /** 업로드가 끝난 뒤 서버가 확인한 바이트 크기입니다. */
  size: number;
  /** 준비된 파일만 돌아옵니다. 마무리되지 않은 업로드는 나오지 않습니다. */
  status: "ready";
  /** 분리된 `media.naru.pub` 출처에서 제공되는 공개 주소입니다. */
  url: string;
  /** 업로드할 때 함께 넘긴 정보입니다. 대체 텍스트나 이 파일을 쓰는 문서
   * 목록처럼 애플리케이션이 정하는 값입니다. */
  metadata: Json;
  created_at: string;
  updated_at: string;
}

/** 사이트가 미디어 한도를 얼마나 쓰고 있는지 보여 줍니다. */
export interface MediaUsage {
  /** 준비된 파일이 차지한 바이트입니다. */
  bytes: number;
  /** 준비된 파일 수입니다. */
  count: number;
  /** 아직 마무리되지 않은 업로드 수입니다. 한 시간 뒤 정리됩니다. */
  pending: number;
  /** 이 사이트에 허용된 전체 바이트입니다. */
  maxBytes: number;
  /** 이 사이트에 허용된 전체 파일 수입니다. */
  maxFiles: number;
}

/** 관리자 세션에서만 닿을 수 있는 미디어 라이브러리입니다. */
export interface FileStore {
  /** @throws 파일이 없으면 `status: 404`인 NaruDataError. */
  get(id: string): Promise<StoredFile>;
  /** 이 사이트의 준비된 파일 전부입니다. 쪽 나눔은 없습니다. */
  list(): Promise<StoredFile[]>;
  /** 이 사이트의 미디어 한도에서 쓰고 있는 양입니다. */
  usage(): Promise<MediaUsage>;
  /**
   * 파일 하나를 올리고 서버가 확인할 때까지 기다립니다.
   *
   * 바이트는 제어판을 거치지 않고 짧게 유효한 서명 주소로 저장소에 바로
   * 갑니다. 그래서 업로드가 실패해도 남는 것이 없습니다. SDK가 오류를 던지기
   * 전에 잡아 둔 자리를 되돌립니다.
   *
   * 이미지, 오디오, PDF, ZIP, 일반 텍스트를 받습니다. HTML과 SVG는 미디어
   * 출처에서 실행될 수 있어 거부합니다. 문서에는 바이트가 아니라 돌아온 `id`나
   * `url`을 저장하세요.
   *
   * ```js
   * const image = await owner.files.upload(input.files[0], {
   *   onProgress: ({ loaded, total }) => bar.value = loaded / total,
   *   metadata: { altText: "비둘기" },
   * });
   * await owner.collection("posts").update("hello", { cover: image.url });
   * ```
   *
   * @param file 입력에서 받은 `File`이거나 아무 `Blob`입니다.
   * @throws 빈 파일이거나 파일 하나의 한도를 넘으면 TypeError.
   */
  upload(
    file: File | Blob,
    options?: {
      /** 바이트가 나가는 동안 불립니다. 전송 길이를 알 수 없으면 파일 크기를
       * total로 알려 줍니다. */
      onProgress?: (progress: { loaded: number; total: number }) => void;
      /** 전송을 멈추고 잡아 둔 자리를 되돌립니다. */
      signal?: AbortSignal;
      /** 대체 텍스트나 이 파일을 쓰는 문서 목록처럼 애플리케이션이 정하는
       * 값입니다. */
      metadata?: Json;
    },
  ): Promise<StoredFile>;
  /** 저장된 파일과 그 정보를 지웁니다. 이 파일을 쓰는 문서는 그대로 남으니
   * 먼저 확인하세요. */
  delete(id: string): Promise<{ success: true }>;
}

/**
 * `completeOwnerSignIn()`이 돌려주는, 사이트 관리자로 인증된
 * 클라이언트입니다.
 *
 * 비공개 컬렉션과 미디어 라이브러리, 묶음 쓰기에 닿되 콜백 등록에 적어 둔
 * 컬렉션까지만 허용됩니다. 공개 클라이언트는 그대로 쓸 수 있고 계속 익명입니다.
 * 토큰을 보내는 것은 이 클라이언트뿐입니다.
 *
 * 토큰은 탭 안에서만 사는 `sessionStorage`에 있고, 그 페이지의 어떤 스크립트든
 * 읽을 수 있습니다. 편집 페이지에는 외부 스크립트를 두지 마세요.
 */
export interface OwnerDatabase extends Database {
  /** 관리자 세션이 끝나는 시각(최대 24시간)이며 유닉스 밀리초입니다. */
  expiresAt: number;
  files: FileStore;
  /** 전부 반영하거나 전부 되돌립니다.
   *
   * 서버 트랜잭션 하나로 처리되므로, 두 컬렉션을 어긋나지 않게 지키는 방법입니다.
   * 글을 공개하면서 초고를 지우는 일이 둘 다 일어나거나 둘 다 일어나지 않습니다.
   * 결과는 넘긴 작업과 같은 순서로 돌아옵니다.
   *
   * ```js
   * await owner.batch([
   *   { type: "set", collection: "posts", id: "hello", data: post },
   *   { type: "delete", collection: "drafts", id: "hello" },
   * ]);
   * ```
   */
  batch(operations: BatchOperation[]): Promise<{
    results: Array<{ id?: string; version?: number; success?: true }>;
  }>;
  /** 이 클라이언트를 무효로 만들고, 서버에 폐기를 요청하기 전에 저장된 자격
   * 증명을 지웁니다. 연결이 끊겨 있으면 서버 폐기는 실패할 수 있습니다. */
  signOut(): Promise<void>;
}

/** SDK가 실제 서비스에서 이야기하는 유일한 제어판입니다. */
export const CONTROL_PLANE_ORIGIN: "https://naru.pub";

/**
 * 사이트 하나의 데이터베이스 클라이언트를 만듭니다.
 *
 * 요청은 일어나지 않습니다. 인자를 확인하고 손잡이를 돌려줄 뿐입니다. 돌아온
 * 클라이언트는 공개용입니다. 관리자 클라이언트는 `signInAsOwner()`와
 * `completeOwnerSignIn()`으로 따로 얻어 함께 씁니다.
 *
 * ```js
 * const db = createDatabase({ site: "alice" });
 * const { documents } = await db.collection("posts").list({ limit: 20 });
 * ```
 *
 * @throws `site`가 올바른 로그인 이름이 아니거나, `controlPlaneOrigin`이
 * `https://naru.pub`도 HTTP 루프백 출처도 아니거나, `schemas`가 함수를 담은
 * 객체가 아니면 TypeError.
 */
export function createDatabase(options: {
  /** 사이트의 나루 로그인 이름입니다. `내-로그인-이름.naru.pub`의 앞부분입니다. */
  site: string;
  /** 개발용 우회 설정입니다. HTTP 루프백 출처만 받습니다. */
  controlPlaneOrigin?: string;
  /** 컬렉션에 쓰기 전에 실행되는 동기 검사기입니다. false를 돌려주거나 오류를
   * 던지면 그 문서를 거부합니다. */
  schemas?: Record<string, (data: Json) => boolean | void>;
}): Database & {
  /** 화면을 전환합니다. 등록해 둔 콜백 페이지에서 completeOwnerSignIn()을
   * 부르세요.
   *
   * 나루로 이동해 관리자가 로그인하고 동의한 뒤 콜백으로 돌아옵니다. 페이지를
   * 떠나므로 이 호출 뒤의 코드는 실행되지 않습니다.
   *
   * @throws `collections`가 서로 다른 이름 1~100개가 아니거나, 콜백에 질의
   * 문자열·조각·자격 증명이 붙어 있거나 다른 출처면 TypeError.
   * @throws 콜백을 제어판에 등록하지 않았으면 코드가
   * `UNREGISTERED_REDIRECT_URI`인 NaruDataError. */
  signInAsOwner(options: {
    /** 보통은 등록된 콜백 주소에서 찾아냅니다. */
    clientId?: string;
    /** 기본값은 지금 페이지의 출처와 경로입니다. 등록해 둔 값과 정확히 같아야
     * 합니다. */
    redirectUri?: string;
    /** 이 세션이 닿을 컬렉션입니다. 등록에 적어 둔 목록 안에 있어야 합니다. */
    collections: string[];
  }): Promise<void>;
  /** 승인을 마무리하거나, 이 탭·페이지의 sessionStorage에 있던 토큰을
   * 되살립니다. 서버 폐기 여부는 데이터 요청마다 확인합니다. 토큰이 없거나 이미
   * 만료됐으면 null을 돌려줍니다.
   *
   * 페이지를 열 때마다 불러도 되고, 되살릴 것이 없으면 값싸게 끝납니다. 주소에서
   * `code`와 `state`를 먼저 지우므로 무엇을 그리기 전에 부르세요. 되살린다고
   * 만료 시각이 늘어나지는 않으며, 갱신 토큰도 없습니다. 세션이 끝나면 다시
   * 로그인해야 합니다. */
  completeOwnerSignIn(): Promise<OwnerDatabase | null>;
};
