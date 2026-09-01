export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export interface Document<T = Json> {
  id: string;
  data: T;
  created_at: string;
  updated_at: string;
  /** Increments on every accepted write. Quote it back as `ifVersion`. */
  version: number;
  metadata: Json;
}
export interface Written {
  id: string;
  version: number;
}
export interface Conditional {
  /** Reject with a `VERSION_CONFLICT` NaruDataError unless the stored version
   * still matches. `0` requires that the document not exist yet. */
  ifVersion?: number;
}
export class NaruDataError extends Error {
  /** HTTP status, or 0 when no HTTP response was received. */
  status: number;
  /** Stable machine-readable failure code. */
  code: string;
  cause?: unknown;
  constructor(status: number, message: string, code?: string);
}
/** Range bounds compare within one JSONB type: a string bound never matches a
 * numeric field, and documents missing the field are excluded. */
export interface RangeFilter {
  gt?: string | number;
  gte?: string | number;
  lt?: string | number;
  lte?: string | number;
}
/** Up to 5 predicates on top-level fields, combined with AND. A scalar is an
 * exact equality match; a comparison object is a range. Both bounds of one
 * range must share a type. */
export type Filter = Record<string, string | number | boolean | null | RangeFilter>;
/** `data.<field>` sorts on a top-level document field. Absent fields sort with
 * JSON null, below strings, which sort below numbers. */
export type OrderBy = "id" | "created_at" | "updated_at" | `data.${string}`;
export interface QueryOptions {
  where?: Filter;
  orderBy?: OrderBy;
  direction?: "asc" | "desc";
}
export interface ListOptions extends QueryOptions {
  limit?: number;
  /** Opaque cursor from the same collection, sort order and filters. */
  after?: string;
}
export interface Collection<T = Json> {
  get(id: string): Promise<Document<T>>;
  list(
    options?: ListOptions,
  ): Promise<{ documents: Document<T>[]; nextCursor: string | null }>;
  /** Every matching document, paging on demand. `limit` is the page size. */
  all(options?: Omit<ListOptions, "after">): AsyncIterableIterator<Document<T>>;
  /** Number of matching documents, counted by the server without paging. */
  count(options?: { where?: Filter }): Promise<number>;
  add(data: T): Promise<Written>;
  set(id: string, data: T, options?: Conditional): Promise<Written>;
  /** Shallow merge: patch fields replace stored fields and `unset` names are
   * removed. The document must already exist and hold a JSON object. Schema
   * validators are not run, because a patch is a fragment. */
  update(
    id: string,
    patch: Partial<T>,
    options?: Conditional & { unset?: (keyof T & string)[] },
  ): Promise<Written>;
  delete(id: string, options?: Conditional): Promise<{ success: true }>;
}
export interface Database {
  /** Types describe your schema; reads are not runtime schema validation. */
  collection<T = Json>(name: string): Collection<T>;
}
export type BatchOperation = { collection: string; id: string } & Conditional &
  (
    | { type: "set"; data: Json }
    | { type: "update"; data: Json; unset?: string[] }
    | { type: "delete" }
  );
export interface StoredFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
  status: "ready";
  url: string;
  /** Application metadata supplied at upload, such as alt text and the
   * documents that reference this file. */
  metadata: Json;
  created_at: string;
  updated_at: string;
}
export interface MediaUsage {
  bytes: number;
  count: number;
  pending: number;
  maxBytes: number;
  maxFiles: number;
}
export interface FileStore {
  get(id: string): Promise<StoredFile>;
  list(): Promise<StoredFile[]>;
  /** Storage consumed against this site's media quota. */
  usage(): Promise<MediaUsage>;
  upload(
    file: File | Blob,
    options?: {
      onProgress?: (progress: { loaded: number; total: number }) => void;
      signal?: AbortSignal;
      /** Application metadata such as alt text and document references. */
      metadata?: Json;
    },
  ): Promise<StoredFile>;
  delete(id: string): Promise<{ success: true }>;
}
export interface OwnerDatabase extends Database {
  /** Maximum owner session expiration (up to 24 hours), in Unix milliseconds. */
  expiresAt: number;
  files: FileStore;
  /** Atomically applies all operations or none. */
  batch(
    operations: BatchOperation[],
  ): Promise<{
    results: Array<{ id?: string; version?: number; success?: true }>;
  }>;
  /** Invalidates this client and attempts storage cleanup before server revocation. Offline revocation may fail. */
  signOut(): Promise<void>;
}
export const CONTROL_PLANE_ORIGIN: "https://naru.pub";
export function createDatabase(options: {
  site: string;
  /** Development override. Only HTTP loopback origins are accepted. */
  controlPlaneOrigin?: string;
  /** Optional synchronous validators run before collection writes. Return false or throw to reject a document. */
  schemas?: Record<string, (data: Json) => boolean | void>;
}): Database & {
  /** Starts a redirect. Call completeOwnerSignIn() on the registered callback page. */
  signInAsOwner(options: {
    /** Normally discovered from the registered redirect URI. */
    clientId?: string;
    redirectUri?: string;
    collections: string[];
  }): Promise<void>;
  /** Completes approval or restores the token from this tab/page sessionStorage. Server revocation is checked on data requests. Returns null if missing or locally expired. */
  completeOwnerSignIn(): Promise<OwnerDatabase | null>;
};
