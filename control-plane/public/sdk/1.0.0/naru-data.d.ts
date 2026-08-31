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
  status: number;
}
export interface Database {
  collection(name: string): {
    get(id: string): Promise<Document>;
    list(options?: {
      limit?: number;
      /** Opaque cursor from the same collection and sort order. */
      after?: string;
      orderBy?: "id" | "created_at" | "updated_at";
      direction?: "asc" | "desc";
    }): Promise<{ documents: Document[]; nextCursor: string | null }>;
    add(data: Json): Promise<{ id: string }>;
    set(id: string, data: Json): Promise<{ id: string }>;
    delete(id: string): Promise<{ success: true }>;
  };
}
export interface OwnerDatabase extends Database {
  /** Local expiration time in milliseconds since Unix epoch. */
  expiresAt: number;
  /** Drops local credentials even if server revocation fails. */
  signOut(): Promise<void>;
}
export function createDatabase(options: {
  site: string;
  baseUrl?: string;
}): Database & {
  /** Starts a redirect. Call completeOwnerSignIn() on the registered callback page. */
  signInAsOwner(options: {
    clientId: string;
    redirectUri?: string;
    collections: string[];
  }): Promise<void>;
  /** Returns null when there is no authorization response; access token stays in memory. */
  completeOwnerSignIn(): Promise<OwnerDatabase | null>;
};
