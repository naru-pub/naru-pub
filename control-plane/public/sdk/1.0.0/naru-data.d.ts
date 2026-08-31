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
}
export class NaruDataError extends Error {
  /** HTTP status, or 0 when no HTTP response was received. */
  status: number;
  cause?: unknown;
  constructor(status: number, message: string);
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
export interface OwnerDatabase extends Database {
  /** Maximum owner session expiration (up to 24 hours), in Unix milliseconds. */
  expiresAt: number;
  /** Invalidates this client and attempts storage cleanup before server revocation. Offline revocation may fail. */
  signOut(): Promise<void>;
}
export const CONTROL_PLANE_ORIGIN: "https://naru.pub";
export function createDatabase(options: { site: string }): Database & {
  /** Starts a redirect. Call completeOwnerSignIn() on the registered callback page. */
  signInAsOwner(options: {
    clientId: string;
    redirectUri?: string;
    collections: string[];
  }): Promise<void>;
  /** Completes approval or restores the token from this tab/page sessionStorage. Server revocation is checked on data requests. Returns null if missing or locally expired. */
  completeOwnerSignIn(): Promise<OwnerDatabase | null>;
};
