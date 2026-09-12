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
  /** 저장한 JSON 또는 parse의 반환값입니다. parse 없이 지정한 T는 검증되지 않습니다. */
  data: T;
  /** 서버가 매기는 ISO 8601 생성 시각이며, `set`으로 교체해도 유지됩니다. */
  createdAt: string;
  /** 가장 최근에 반영된 쓰기의 ISO 8601 시각입니다. */
  updatedAt: string;
  /** 쓰기가 반영될 때마다 증가합니다. `ifVersion`으로 되돌려 주세요. */
  version: number;
}

/** 쓰기가 성공했을 때 돌아오는 값입니다.
 *
 * 서버가 실제로 찍은 시각이 함께 옵니다. 방금 저장한 것을 곧바로 화면에 그릴
 * 때 브라우저 시계로 시각을 지어낼 필요가 없고, 목록에 이미 있는 서버 시각과
 * 같은 기준으로 정렬됩니다. */
export interface Written {
  /** 직접 정한 문서 ID이거나, `add`가 매긴 UUID입니다. */
  id: string;
  /** 이 쓰기가 만든 버전입니다. 새로 만든 문서는 `1`입니다. */
  version: number;
  /** 서버가 매긴 ISO 8601 생성 시각입니다. `set`으로 교체해도 유지됩니다. */
  createdAt: string;
  /** 이 쓰기가 반영된 ISO 8601 시각입니다. 새로 만든 문서는 `createdAt`과
   * 같습니다. */
  updatedAt: string;
}

/** 요청 취소와 시간 제한입니다. 취소나 시간 초과 뒤에도 서버에 쓰기가
 * 반영됐을 수 있으므로 쓰기를 자동으로 재시도하지 않습니다. */
export interface RequestOptions {
  /** 취소하면 REQUEST_ABORTED 오류가 납니다. */
  signal?: AbortSignal;
  /** 응답 본문을 읽기까지의 제한 시간입니다. 기본 30초, 0은 제한 없음입니다.
   * 업로드는 승인·전송·마무리를 합쳐 기본 120초이며, all은 쪽마다 적용됩니다.
   * 시간 초과는 REQUEST_TIMEOUT 오류입니다. */
  timeoutMs?: number;
  /**
   * 캐시를 건너뛰고 서버에 직접 묻습니다.
   *
   * 누구나 읽을 수 있는 컬렉션을 로그인 없이 읽으면, 그 응답은 10초 동안 캐시될
   * 수 있습니다. 방문자가 많은 사이트에서 같은 목록을 사람 수만큼 데이터베이스에
   * 묻지 않기 위해서입니다.
   *
   * 이 브라우저에서 방금 쓴 컬렉션은 로그인 여부와 상관없이 SDK가 그 10초 동안
   * 알아서 캐시를 건너뛰므로, 내가 쓴 것을 다시 읽으려고 이 옵션을 넘길 필요는
   * 없습니다. 다른 탭이나 기기에서 쓴 것을 곧바로 봐야 할 때만 쓰세요.
   *
   * 관리자 토큰으로 보내는 요청과 쓰기는 원래 캐시를 쓰지 않으므로 영향이
   * 없습니다.
   */
  fresh?: boolean;
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
   * `UNREGISTERED_REDIRECT_URI`, `UPLOAD_REDIRECTED` 등이 있고, 분류되지 않은
   * 실패는 `REQUEST_FAILED`입니다. */
  code: string;
  /** 원인이 된 네트워크 오류나 파싱 오류입니다. */
  cause?: unknown;
  /** 실패한 업로드의 파일 ID입니다. 승인을 받지 못했으면 없을 수 있습니다. */
  fileId?: string;
  /** 업로드 실패 뒤 정리 요청도 실패했을 때의 오류입니다. */
  cleanupError?: unknown;
  /** 읽기 검사에 실패한 컬렉션 이름입니다. */
  collection?: string;
  /** 읽기 검사에 실패한 문서 ID입니다. */
  documentId?: string;
  constructor(status: number, message: string, code?: string);
}

export interface RequestChannel {
  /** Aborts the previous request and returns a signal for the new request. */
  next(reason?: unknown): AbortSignal;
  /** Aborts the current request, if any. */
  cancel(reason?: unknown): void;
}

export function createRequestChannel(): RequestChannel;

/** 범위 비교는 JSONB 타입 안에서만 이루어집니다. 문자열 경계는 수 필드와 절대
 * 맞지 않고, 그 필드가 없는 문서는 결과에서 빠집니다. */
export interface RangeFilter<T extends string | number = string | number> {
  /** 초과. */
  gt?: T;
  /** 이상. */
  gte?: T;
  /** 미만. */
  lt?: T;
  /** 이하. */
  lte?: T;
}

/** 최상위 필드에 조건을 최대 5개까지 걸고 AND로 묶습니다. 빈 객체 `{}`는 거르지
 * 않는다는 뜻이라, 조건을 조립하다 아무것도 남지 않아도 그대로 넘기면 됩니다. 스칼라 값은 정확히
 * 같은지 보고, 비교 객체는 범위를 봅니다. 한 필드의 두 경계는 타입이 같아야
 * 합니다.
 *
 * 같은지 보는 기준은 엄격합니다. `1`은 `"1"`과 다르고, 문자열은 대소문자를
 * 가리며, `null`은 저장된 null과 맞을 뿐 필드가 없는 문서와는 맞지 않습니다.
 * 중첩 경로, 배열 포함 여부, OR, 부분 문자열 검색은 지원하지 않습니다.
 *
 * Collection<T>에서는 T의 필드 이름과 값 타입을 검사합니다. 타입을 생략하면
 * 임의의 필드 이름을 사용할 수 있습니다.
 *
 * 필터는 주소 질의 문자열에 실려 가므로, 비밀 값으로는 거르지 마세요.
 *
 * ```js
 * // 올해 공개된 글을 최신순으로.
 * await db.collection("posts").list({
 *   where: { published: true, createdAt: { gte: "2026-01-01" } },
 *   orderBy: "createdAt",
 *   direction: "desc",
 * });
 * ```
 */
export type Filter<T = Json> = Json extends T
  ? Record<string, string | number | boolean | null | RangeFilter>
  : [FieldNames<T>] extends [never]
    ? Record<string, never>
    : { [K in FieldNames<T>]?: FilterValue<FieldValue<T, K>> };

/** 문서 객체의 최상위 문자열 키입니다. 타입을 생략하면 모든 필드 이름을 받습니다.
 * 유니온 문서는 각 형태의 키를 합치고 배열 인덱스는 포함하지 않습니다. */
export type FieldNames<T = Json> = Json extends T
  ? string
  : T extends readonly unknown[]
    ? never
    : T extends object
      ? Extract<keyof T, string>
      : never;

/** 유니온 문서에서 해당 필드가 가질 수 있는 값입니다. */
export type FieldValue<T, K extends string> = Json extends T
  ? Json
  : T extends unknown
    ? K extends keyof T
      ? T[K]
      : never
    : never;

/** 같은지 비교할 때는 필드 값의 타입을, 범위 비교에는 문자열 또는 숫자를 씁니다.
 * 객체와 배열 비교는 지원하지 않습니다. 한 범위의 경계는 같은 타입이어야 합니다. */
export type FilterValue<T> =
  | Extract<T, string | number | boolean | null>
  | (Extract<T, string> extends never ? never : RangeFilter<string>)
  | (Extract<T, number> extends never ? never : RangeFilter<number>);

/** `data.<필드>`는 문서의 최상위 필드로 정렬합니다. 값이 없는 필드는 JSON
 * null로 취급되어 문자열보다 아래에, 문자열은 수보다 아래에 놓입니다.
 *
 * `id`, `createdAt`, `updatedAt`은 서버 메타데이터로 정렬합니다. 시각이 같으면
 * 같은 방향의 ID 순으로 갈립니다. 목록에는 바뀌지 않는 `createdAt`을
 * 권합니다. 넘겨보는 도중에 값이 바뀌는 필드로 정렬하면 문서가 빠지거나 두 번
 * 나올 수 있습니다. */
export type OrderBy<T = Json> =
  | "id"
  | "createdAt"
  | "updatedAt"
  | `data.${FieldNames<T>}`;

/** 둘째 정렬 키까지 지정합니다. 문서 ID는 마지막 키로 자동 추가됩니다. */
export type MultiOrderBy<T = Json> =
  | readonly [readonly [OrderBy<T>, "asc" | "desc"]]
  | readonly [
      readonly [OrderBy<T>, "asc" | "desc"],
      readonly [OrderBy<T>, "asc" | "desc"],
    ];

/** `list`, `all`, `count`가 함께 쓰는 거르기와 정렬 옵션입니다. */
export interface QueryOptions<T = Json> extends RequestOptions {
  /** 거르지 않으려면 생략하거나 `{}`를 넘기세요. */
  where?: Filter<T>;
  /** 기본값은 `id`입니다. 배열은 두 키까지 받으며 ID가 마지막에 자동으로 붙습니다. */
  orderBy?: OrderBy<T> | MultiOrderBy<T>;
  /** 단일 orderBy의 기본값은 `asc`입니다. 배열 orderBy와 함께 쓰지 않습니다. */
  direction?: "asc" | "desc";
}

/** 쪽을 알아서 넘겨 가며 훑는 `all`의 한도입니다. */
export interface WalkOptions {
  /**
   * 훑을 최대 개수입니다. 기본값은 1000이고, 여기에 닿으면
   * `WALK_LIMIT_EXCEEDED` NaruDataError가 납니다.
   *
   * `all`은 배열을 도는 것처럼 보이지만 쪽마다 요청 한 번입니다. 컬렉션 전체를
   * 훑으면 요청 백 번이 되고, 그 요청은 모두 사이트마다 하나뿐인 잠금을 지나
   * 갑니다. 그래서 끝이 없는 훑기는 실수로는 일어나지 않게 막아 두었습니다.
   * 정말 전부가 필요하면 `max`를 직접 올리거나 `Infinity`를 넘기세요. 대개는
   * `where`로 좁히거나 `list`로 직접 쪽을 넘기는 쪽이 맞습니다.
   */
  max?: number;
}

/** 컬렉션의 한 쪽입니다. */
export interface ListOptions<T = Json> extends QueryOptions<T> {
  /** 한 쪽에 담을 문서 수입니다. 기본값은 50이고, 지금 서버가 받는 최댓값은
   * 100입니다. 한도는 서버가 정하며 넘으면 서버가 400으로 거절합니다. */
  limit?: number;
  /** 같은 컬렉션, 같은 정렬, 같은 필터에서 받은 페이지 토큰입니다. `null`은
   * 첫 쪽이므로 앞선 쪽의 `nextPageToken`을 그대로 넘기면 됩니다. */
  pageToken?: string | null;
  /** 참이면 같은 필터의 전체 개수를 응답의 `total`에 함께 받습니다. */
  includeTotal?: boolean;
}

/**
 * 컬렉션 하나를 가리키는 손잡이입니다. `Database.collection`에서 얻으며,
 * 손잡이를 만드는 것만으로는 요청이 일어나지 않습니다.
 *
 * `T`는 저장하려는 문서의 형태이고 `M`은 읽어서 돌려받는 값입니다.
 * `createDatabase`의 `collections`에 등록한 `parse`와 `map`에서 추론되며,
 * 등록하지 않으면 `T`는 검사되지 않는 약속일 뿐입니다. 서버는 이를 검사하지
 * 않습니다.
 */
export interface Collection<T = Json, M = Document<T>> {
  /**
   * ID로 문서 하나를 가져옵니다.
   *
   * @throws 문서가 없으면 `status: 404`인 NaruDataError.
   */
  get(id: string, options?: RequestOptions): Promise<M>;
  /**
   * 한 쪽을 가져옵니다.
   *
   * 컬렉션 끝에 이르면 `nextPageToken`이 `null`입니다. 그 값을 그대로 `pageToken`으로
   * 넘기면 되고, `null`은 첫 쪽이라는 뜻입니다. 이때 `where`, `orderBy`, `direction`은 똑같이 유지하세요. 커서는 그것을
   * 만든 질의에 묶여 있어서, 필터가 달라지면 400으로 거부됩니다. 쪽 크기는
   * 중간에 바꿔도 됩니다.
   *
   * 넘겨보는 동안의 상태가 고정되지는 않습니다. 훑는 사이에 커서 앞쪽으로 들어온
   * 문서는 처음부터 다시 읽어야 보입니다.
   *
   * ```js
   * let pageToken = null;
   * do {
   *   const page = await posts.list({ limit: 20, pageToken });
   *   render(page.documents);
   *   pageToken = page.nextPageToken;
   * } while (pageToken);
   * ```
   */
  list(options?: ListOptions<T>): Promise<{
    documents: M[];
    nextPageToken: string | null;
    /** includeTotal이 참일 때만 있습니다. */
    total?: number;
  }>;
  /** 조건에 맞는 모든 문서를 필요할 때마다 한 쪽씩 가져옵니다. `limit`은 쪽
   * 크기입니다.
   *
   * 커서가 반복되면 INVALID_PAGINATION, 응답 형태가 잘못되면 INVALID_RESPONSE
   * 오류가 납니다.
   *
   * 반복자가 그 쪽에 닿을 때 비로소 요청하므로, 중간에 멈추면 요청도 멈춥니다.
   *
   * ```js
   * for await (const post of posts.all({ orderBy: "createdAt" })) {
   *   if (post.data.title === needle) return post;
   * }
   * ```
   */
  all(
    options?: Omit<ListOptions<T>, "pageToken" | "includeTotal"> & WalkOptions,
  ): AsyncIterableIterator<M>;
  /** 조건에 맞는 문서 수를 서버가 쪽 나눔 없이 세어 돌려줍니다.
   *
   * 셀 뿐이라 정렬할 쪽이 없습니다. `orderBy`나 `direction`을 넘기면 요청 전에
   * TypeError로 거부합니다. */
  count(options?: RequestOptions & { where?: Filter<T> }): Promise<number>;
  /**
   * 서버가 매긴 UUID로 문서를 새로 만듭니다.
   *
   * 새로 만들기만 하므로 기존 문서를 덮어쓰지 않습니다. 읽기 권한도 필요 없어서,
   * 아무도 목록을 볼 수 없는 컬렉션에도 방명록을 만들 수 있습니다. 등록한
   * `parse`가 요청 전에 문서를 검사합니다.
   */
  add(data: T, options?: RequestOptions): Promise<Written>;
  /**
   * 문서 전체를 바꾸고, 없으면 새로 만듭니다.
   *
   * 합치기가 아니라 교체입니다. `data`에 없는 필드는 사라집니다. 문서의 일부만
   * 바꾸려면 `Collection.update`를 쓰세요. 교체해도 `createdAt`은 남습니다.
   * 등록한 `parse`가 요청 전에 문서를 검사합니다.
   */
  set(
    id: string,
    data: T,
    options?: RequestOptions & Conditional,
  ): Promise<Written>;
  /** 얕은 합치기입니다. 패치에 있는 필드가 저장된 필드를 대신하고, `unset`에
   * 적은 이름은 지워집니다. 문서가 이미 있고 JSON 객체를 담고 있어야 합니다.
   * 패치는 조각이라 문서 전체를 보는 `parse`는 실행되지 않습니다.
   *
   * 합치기는 한 겹까지입니다. 패치 안의 중첩 객체는 저장된 중첩 객체에 섞이지
   * 않고 통째로 대신합니다.
   *
   * @throws 문서가 없으면 `status: 404`인 NaruDataError.
   */
  update(
    id: string,
    patch: Partial<T>,
    options?: RequestOptions & Conditional & { unset?: FieldNames<T>[] },
  ): Promise<Written>;
  /**
   * 문서를 지웁니다.
   *
   * 여러 번 해도 같습니다. 없는 문서를 지워도 성공합니다. 이미 읽어 둔 그 문서만
   * 지우려면 `ifVersion`을 넘기세요.
   */
  delete(
    id: string,
    options?: RequestOptions & Conditional,
  ): Promise<{ success: true }>;
}

/** `createDatabase`가 돌려주는 공개 클라이언트입니다. 인증 없이 요청하므로
 * 컬렉션의 공개 범위가 허용한 곳까지만 닿습니다.
 *
 * 묶음 쓰기와 미디어 라이브러리는 여기 없습니다. 둘 다 관리자 토큰이 있어야
 * 하므로, 익명 클라이언트에 달려 있어 봐야 거절만 돌려받습니다.
 * `completeOwnerSignIn()`이 돌려주는 OwnerDatabase에서 쓰세요. */
export interface Database<C extends CollectionDefinitions = {}> {
  /** 등록한 컬렉션은 `parse`와 `map`에서 타입을 추론하고 읽기와 쓰기에 둘을
   * 실행합니다. 검사와 변환은 여기가 아니라 `createDatabase`의 `collections`에
   * 한 번 등록하므로, 관리자 클라이언트도 같은 규칙을 씁니다. */
  collection<N extends Extract<keyof C, string>>(
    name: N,
  ): Collection<DefinedData<C[N]>, DefinedDocument<C[N]>>;
  /** 등록하지 않은 컬렉션입니다. `T`는 검사되지 않는 타입 표시입니다. */
  collection<T = Json>(name: string): Collection<T>;
}

/** 동기 함수가 돌려줄 수 있는 값입니다. `then`이 있는 값, 곧 Promise는
 * 빠집니다. */
export type Synchronous =
  | void
  | null
  | undefined
  | string
  | number
  | boolean
  | bigint
  | symbol
  | (object & { then?: never });

/**
 * 컬렉션 하나를 읽고 쓰는 규칙입니다. 서버의 스키마나 쓰기 검사를 바꾸지
 * 않습니다.
 *
 * TypeScript에서는 `parse`의 반환 타입이 컬렉션의 문서 타입이 됩니다. `map`의
 * 인자는 추론되지 않으니 `Document<Post>`처럼 적어 주세요.
 *
 * ```js
 * const db = createDatabase({
 *   site: "alice",
 *   collections: {
 *     posts: {
 *       parse(data) {
 *         if (typeof data?.title !== "string") throw new TypeError("제목이 없습니다.");
 *         return data;
 *       },
 *       map: (document) => ({ ...document.data, id: document.id }),
 *     },
 *   },
 * });
 * const post = await db.collection("posts").get("hello"); // post.title
 * ```
 */
export interface CollectionDefinition {
  /** JSON을 검사한 뒤 사용할 값을 반환하는 동기 함수입니다. 검사에 실패하면
   * 오류를 던지세요. false나 undefined도 정상 반환값이며 실패 신호가 아닙니다.
   *
   * `get`, `list`, `all`이 읽은 각 문서의 data에 실행하고, 반환값이 문서의 data가
   * 됩니다. ID, 시각, 버전은 서버 값 그대로입니다. 읽기에서 오류를 던지거나
   * Promise를 반환하면 DOCUMENT_VALIDATION_FAILED 오류가 납니다. 오류의
   * collection, documentId, cause에서 실패 위치와 원인을 확인하세요. list와
   * all은 한 쪽을 전부 검사한 뒤 반환하므로 잘못된 문서를 건너뛰지 않습니다.
   *
   * `add`, `set`과 묶음의 `add`, `set`은 요청 전에 같은 함수로 문서를 검사하고,
   * 던진 오류를 그대로 전달합니다. 반환값은 저장되지 않고 넘긴 JSON이 그대로
   * 저장됩니다. 조각인 `update`, 그리고 `count`와 `delete`에는 실행되지 않습니다. */
  parse?(data: Json): Synchronous;
  /** parse 뒤의 문서와 서버 메타데이터를 애플리케이션 값으로 바꾸는 동기
   * 함수입니다. 읽기에만 실행됩니다. */
  map?(document: Document<never>): Synchronous;
}

/** 컬렉션 이름마다 하나씩 등록하는 규칙입니다. */
export type CollectionDefinitions = { [name: string]: CollectionDefinition };

/** 규칙의 `parse`가 만드는 값이며, `parse`가 없으면 Json입니다. */
export type DefinedData<D> = D extends {
  parse(data: Json): infer T;
}
  ? T
  : Json;

/** 규칙의 `map`이 만드는 값이며, `map`이 없으면 문서입니다. */
export type DefinedDocument<D> = D extends {
  map(document: never): infer M;
}
  ? M
  : Document<DefinedData<D>>;

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

/** 삭제는 success, 나머지 쓰기는 id와 version을 돌려줍니다. */
export type BatchResult<T extends BatchOperation = BatchOperation> = T extends {
  type: "delete";
}
  ? { success: true }
  : Written;

/** 입력 작업의 순서와 길이를 유지하는 결과입니다. 일반 배열은 결과 유니온의
 * 배열로, 튜플은 각 위치의 작업에 맞는 결과 튜플로 돌아옵니다. */
export type BatchResults<T extends readonly BatchOperation[]> = {
  -readonly [K in keyof T]: BatchResult<T[K]>;
};

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
  /** 애플리케이션이 정하는 값입니다. 대체 텍스트나 이 파일을 쓰는 글의 ID처럼
   * 나중에 찾아야 하는 것을 담으세요. `FileStore.list`의 `where`가 이 안의
   * 최상위 필드를 거르므로, 스칼라로 담아 두면 서버가 찾아 줍니다. */
  metadata: Json;
  /** metadata를 고칠 때마다 증가합니다. `FileStore.update`에 `ifVersion`으로
   * 되돌려 주세요. 갓 올린 파일은 `1`입니다. */
  version: number;
  createdAt: string;
  updatedAt: string;
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
}

/** 업로드 전에 브라우저에서 이미지를 줄이는 방법입니다. 값을 하나도 넘기지
 * 않으면 기본값이 그대로 쓰입니다. 줄이지 않으려면 `original: true`를 쓰세요. */
export interface ImageOptions {
  /** 긴 변의 최대 픽셀입니다. 1에서 16384 사이의 정수이며 기본값은 2048입니다. */
  maxDimension?: number;
  /** 손실 압축을 시작할 품질입니다. 0 초과 1 이하이며 기본값은 0.82입니다.
   * `maxBytes`에 맞추느라 0.4까지 내려갈 수 있습니다. */
  quality?: number;
  /** 다시 인코딩할 형식입니다. 기본값은 `"image/webp"`입니다. 브라우저가 이
   * 형식을 만들지 못하면 JPEG로 대신 줄입니다. */
  type?: "image/webp" | "image/jpeg" | "image/png";
  /** 목표 용량입니다. 기본값은 500 KiB입니다. 이 크기 이하이면서
   * `maxDimension`도 넘지 않는 이미지는 손대지 않고 그대로 올리고, 넘는
   * 이미지는 품질을 먼저, 그래도 모자라면 크기를 줄여 이 안에 맞춥니다. 여섯
   * 번 안에 맞추지 못하면 그중 가장 작은 결과를 올립니다. */
  maxBytes?: number;
}

/** 파일에는 문서 본문이 없으므로, 정렬은 서버 메타데이터로만 합니다. */
export type FileOrderBy = "id" | "createdAt" | "updatedAt";

/** `FileStore.list`와 `FileStore.all`이 쓰는 거르기, 정렬, 쪽 나눔 옵션입니다.
 * `where`는 문서의 `data`가 아니라 파일의 `metadata` 최상위 필드를 봅니다. */
export interface FileListOptions extends RequestOptions {
  /** metadata의 최상위 필드에 거는 조건입니다. 규칙은 `Filter`와 같습니다. */
  where?: Filter;
  /** 기본값은 `createdAt`입니다. */
  orderBy?: FileOrderBy;
  /** 기본값은 `desc`입니다. 최근에 올린 것이 먼저 옵니다. */
  direction?: "asc" | "desc";
  /** 한 쪽에 담을 파일 수입니다. 기본값은 50이고, 지금 서버가 받는 최댓값은
   * 100입니다. 한도는 서버가 정하며 넘으면 서버가 400으로 거절합니다. */
  limit?: number;
  /** 같은 정렬, 같은 필터에서 받은 페이지 토큰입니다. `null`은 첫 쪽입니다. */
  pageToken?: string | null;
}

/** 관리자 세션에서만 닿을 수 있는 미디어 라이브러리입니다. */
export interface FileStore {
  /** @throws 파일이 없으면 `status: 404`인 NaruDataError. */
  get(id: string, options?: RequestOptions): Promise<StoredFile>;
  /**
   * 준비된 파일 한 쪽을 가져옵니다.
   *
   * 컬렉션과 똑같이 커서로 넘겨봅니다. 라이브러리는 시간이 갈수록 자라기만
   * 하므로, 파일 하나를 찾겠다고 전부 받아 오지 마세요. 어느 글에 붙은
   * 이미지인지처럼 찾을 거리를 `metadata`에 스칼라로 담아 두었다면 `where`로
   * 서버에서 거를 수 있습니다.
   *
   * ```js
   * const { files } = await owner.files.list({
   *   where: { postId: "hello" },
   *   limit: 100,
   * });
   * ```
   */
  list(options?: FileListOptions): Promise<{
    files: StoredFile[];
    nextPageToken: string | null;
  }>;
  /** 조건에 맞는 모든 파일을 필요할 때마다 한 쪽씩 가져옵니다. `Collection.all`과
   * 같은 규칙입니다. */
  all(
    options?: Omit<FileListOptions, "pageToken"> & WalkOptions,
  ): AsyncIterableIterator<StoredFile>;
  /** 이 사이트의 미디어 한도에서 쓰고 있는 양입니다. 목록과는 별개의 요청이라,
   * 남은 용량만 보려고 라이브러리를 훑지 않습니다. */
  usage(options?: RequestOptions): Promise<MediaUsage>;
  /**
   * 파일 하나를 올리고 서버가 확인할 때까지 기다립니다.
   *
   * 바이트는 제어판을 거치지 않고 짧게 유효한 서명 주소로 저장소에 바로
   * 갑니다. 승인 뒤 실패하면 취소 신호와 별개로 최대 10초 동안 정리를 시도한
   * 뒤 오류를 던집니다. 오류의 fileId와 cleanupError로 정리 실패를 확인하세요.
   * 승인 응답을 받지 못하면 ID를 알 수 없어 즉시 정리할 수 없습니다. 서버는
   * 오래된 pending 항목을 정리하지만 네트워크 실패 시 즉시 삭제는 보장되지 않습니다.
   *
   * 이미지, 오디오, PDF, ZIP, 일반 텍스트를 받습니다. HTML과 SVG는 미디어
   * 출처에서 실행될 수 있어 거부합니다. 문서에는 바이트가 아니라 돌아온 `id`나
   * `url`을 저장하세요.
   *
   * 큰 사진은 보내기 전에 브라우저에서 줄입니다. JPEG·PNG·WebP는 긴 변이
   * `maxDimension`(기본 2048)을 넘거나 `maxBytes`(기본 500 KiB)보다 무거울 때만
   * 다시 인코딩하고, 품질을 0.4까지 낮춘 뒤에도 모자라면 크기를 줄여
   * `maxBytes` 안에 맞춥니다. 여섯 번 안에 맞추지 못하면 그중 가장 작은 결과를
   * 올리고, 다시 인코딩한 쪽이 원본보다 크면 원본을 올립니다. 아이폰이
   * 저장하는 HEIC는 사파리가 읽을 수 있으면 받는 형식으로 바꿔 주므로,
   * 원래대로면 거부될 사진도 올라갑니다. WebP를 만들지 못하는 브라우저에서는
   * JPEG로 줄입니다. 다시 인코딩한 파일은 EXIF가
   * 사라지므로 회전은 픽셀에 반영해 넣고 촬영 위치는 공개 주소에 남지
   * 않습니다. 원본을 그대로 올리려면 `original: true`를 넘기세요. 한도 확인은
   * 줄인 뒤의 크기로 합니다.
   *
   * ```js
   * const image = await owner.files.upload(input.files[0], {
   *   onProgress: ({ loaded, total }) => bar.value = loaded / total,
   *   image: { maxDimension: 1600 },
   *   metadata: { altText: "비둘기" },
   * });
   * await owner.collection("posts").update("hello", { cover: image.url });
   * ```
   *
   * @param file 입력에서 받은 `File`이거나 아무 `Blob`입니다.
   * @throws 줄인 뒤에도 비어 있거나 파일 하나의 한도를 넘으면 TypeError.
   */
  upload(
    file: File | Blob,
    options?: RequestOptions & {
      /** 진행 상황을 알립니다. 전송 길이를 알 수 없으면 파일 크기를 total로
       * 알려 줍니다.
       *
       * 큰 사진은 승인을 받기 전에 브라우저에서 줄이는데, 그동안은 바이트가
       * 하나도 나가지 않으면서 몇 초가 걸릴 수 있습니다. 다시 인코딩하기로
       * 정해지면 `phase: "resizing"`으로 한 번 불러 주므로, 업로드 중이라고
       * 말하는 막대 대신 그 단계를 그대로 보여 줄 수 있습니다. 어떤 파일이
       * 줄어드는지 SDK의 기준을 따라 짐작할 필요가 없습니다.
       *
       * 전송이 시작되면 `phase: "uploading"`으로 바뀝니다. 이 콜백이 오류를
       * 던지면 업로드는 그 오류로 실패합니다. */
      onProgress?: (progress: {
        loaded: number;
        total: number;
        phase: "resizing" | "uploading";
      }) => void;
      /** 이미지 축소 설정입니다. `original`이 참이면 쓰이지 않습니다. */
      image?: ImageOptions;
      /** 참이면 줄이지 않고 원본 바이트를 그대로 올립니다. 기본값은
       * 거짓입니다. */
      original?: boolean;
      /** 대체 텍스트나 이 파일을 쓰는 문서 목록처럼 애플리케이션이 정하는
       * 값입니다. */
      metadata?: Json;
    },
  ): Promise<StoredFile>;
  /**
   * 파일의 metadata를 얕게 합칩니다. 패치에 있는 필드가 저장된 필드를
   * 대신하고, `unset`에 적은 이름은 지워집니다.
   *
   * 고칠 수 있는 것은 metadata뿐입니다. 바이트와 형식, 크기는 업로드를 승인하고
   * 확인할 때 정해졌습니다. 한 이미지가 붙는 글이 바뀌었을 때처럼, 올릴 때 적어
   * 둔 값이 더 이상 맞지 않으면 이걸로 고치세요.
   *
   * ```js
   * await owner.files.update(
   *   image.id,
   *   { postId: "moved" },
   *   { ifVersion: image.version },
   * );
   * ```
   *
   * @throws 파일이 없으면 `status: 404`, 버전이 어긋나면 `VERSION_CONFLICT`인
   * NaruDataError.
   */
  update(
    id: string,
    patch: { [key: string]: Json },
    options?: RequestOptions & Conditional & { unset?: string[] },
  ): Promise<StoredFile>;
  /** 저장된 파일과 그 정보를 지웁니다. 이 파일을 쓰는 문서는 그대로 남으니
   * 먼저 확인하세요. */
  delete(id: string, options?: RequestOptions): Promise<{ success: true }>;
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
export interface OwnerDatabase<
  C extends CollectionDefinitions = {},
> extends Database<C> {
  /** 현재 관리자 세션 상태. 401, 만료, 로그아웃이 즉시 반영됩니다.
   * `expiresAt`은 세션이 끝나는 시각(최대 24시간)이며 유닉스 밀리초입니다. */
  readonly session: Readonly<{
    status: "active" | "expired" | "signed-out";
    expiresAt: number;
  }>;
  /** 현재 상태를 즉시 한 번 알리고 이후 변경을 구독합니다.
   *
   * 401 응답, 만료 시각 도달, 로그아웃을 모두 여기서 알리므로 세션이 끝났는지
   * 따로 확인하거나 `OWNER_SESSION_EXPIRED` 오류를 따로 잡을 필요가 없습니다.
   *
   * ```js
   * owner.onSessionChange(({ status }) => {
   *   if (status !== "active") hideAdminTools();
   * });
   * ```
   */
  onSessionChange(
    listener: (session: OwnerDatabase["session"]) => void,
  ): () => void;
  files: FileStore;
  /** 전부 반영하거나 전부 되돌립니다.
   *
   * 서버 트랜잭션 하나로 처리되므로, 두 컬렉션을 어긋나지 않게 지키는 방법입니다.
   * 글을 공개하면서 초고를 지우는 일이 둘 다 일어나거나 둘 다 일어나지 않습니다.
   * 결과는 넘긴 작업과 같은 순서로 돌아옵니다. TypeScript 5 이상에서는 직접
   * 넘긴 배열의 각 위치마다 결과 타입을 추론합니다. 일반 BatchOperation[]은
   * Written과 { success: true }의 유니온 배열이므로 사용 전에 구분하세요.
   *
   * ```js
   * await owner.batch([
   *   { type: "set", collection: "posts", id: "hello", data: post },
   *   { type: "delete", collection: "drafts", id: "hello" },
   * ]);
   * ```
   */
  batch<const T extends readonly BatchOperation[]>(
    operations: T,
    options?: RequestOptions,
  ): Promise<{
    results: BatchResults<T>;
  }>;
  /** 이 클라이언트를 무효로 만들고, 서버에 폐기를 요청하기 전에 저장된 자격
   * 증명을 지웁니다. 연결이 끊겨 있으면 서버 폐기는 실패할 수 있습니다. */
  signOut(options?: RequestOptions): Promise<void>;
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
 * `https://naru.pub`도 HTTP 루프백 출처도 아니거나, `collections`가 `parse`와
 * `map` 함수만 담은 규칙의 객체가 아니면 TypeError.
 */
export function createDatabase<C extends CollectionDefinitions = {}>(options: {
  /** 사이트의 나루 로그인 이름입니다. `내-로그인-이름.naru.pub`의 앞부분입니다. */
  site: string;
  /** 개발용 우회 설정입니다. HTTP 루프백 출처만 받습니다. */
  controlPlaneOrigin?: string;
  /** 컬렉션별 검사와 변환을 한 번 등록합니다. 공개 클라이언트와 관리자
   * 클라이언트가 함께 씁니다.
   *
   * 클라이언트를 만들 때 직접 정의된 속성을 검사하고 복사합니다. 상속된 속성은
   * 무시하고 getter와 함수가 아닌 속성은 거부합니다. 이후 원본을 바꿔도 이미
   * 만든 클라이언트에는 영향을 주지 않습니다. */
  collections?: C & CollectionDefinitions;
}): Database<C> & {
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
  signInAsOwner(
    options: RequestOptions & {
      /** 보통은 등록된 콜백 주소에서 찾아냅니다. */
      clientId?: string;
      /** 기본값은 지금 페이지의 출처와 경로입니다. 등록해 둔 값과 정확히 같아야
       * 합니다. */
      redirectUri?: string;
      /** 이 세션이 닿을 컬렉션입니다. 등록에 적어 둔 목록 안에 있어야 합니다. */
      collections: string[];
    },
  ): Promise<void>;
  /** 승인을 마무리하거나, 이 탭·페이지의 sessionStorage에 있던 토큰을
   * 되살립니다. 서버 폐기 여부는 데이터 요청마다 확인합니다. 토큰이 없거나 이미
   * 만료됐으면 null을 돌려줍니다.
   *
   * 페이지를 열 때마다 불러도 되고, 되살릴 것이 없으면 값싸게 끝납니다. 주소에서
   * `code`와 `state`를 먼저 지우므로 무엇을 그리기 전에 부르세요. 되살린다고
   * 만료 시각이 늘어나지는 않으며, 갱신 토큰도 없습니다. 세션이 끝나면 다시
   * 로그인해야 합니다. 동시에 호출하면 첫 호출의 요청 옵션을 공유합니다.
   * 취소나 시간 초과로 토큰 교환에 실패하면 다시 로그인하세요. */
  completeOwnerSignIn(
    options?: RequestOptions,
  ): Promise<OwnerDatabase<C> | null>;
};
