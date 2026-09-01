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
  metadata: Json;
}
export class NaruDataError extends Error {
  /** HTTP status, or 0 when no HTTP response was received. */
  status: number;
  /** Stable machine-readable failure code. */
  code: string;
  cause?: unknown;
  constructor(status: number, message: string, code?: string);
}
export interface Collection<T = Json> {
  get(id: string): Promise<Document<T>>;
  list(options?: {
    limit?: number;
    /** Opaque cursor from the same collection, sort order and filters. */
    after?: string;
    /** Up to 5 top-level scalar equality filters, combined with AND. */
    where?: Record<string, string | number | boolean | null>;
    orderBy?: "id" | "created_at" | "updated_at";
    direction?: "asc" | "desc";
  }): Promise<{ documents: Document<T>[]; nextCursor: string | null }>;
  add(data: T): Promise<{ id: string }>;
  set(id: string, data: T): Promise<{ id: string }>;
  delete(id: string): Promise<{ success: true }>;
}
export interface Database {
  /** Types describe your schema; reads are not runtime schema validation. */
  collection<T = Json>(name: string): Collection<T>;
}
export type BatchOperation =
  | { type: "set"; collection: string; id: string; data: Json }
  | { type: "delete"; collection: string; id: string };
export interface StoredFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
  status: "ready";
  url: string;
  created_at: string;
  updated_at: string;
}
export interface FileStore {
  get(id: string): Promise<StoredFile>;
  list(): Promise<StoredFile[]>;
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
  ): Promise<{ results: Array<{ id?: string; success?: true }> }>;
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
