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
  updated_at: string;
}
export class NaruDataError extends Error {
  status: number;
}
export function createDatabase(options: { site: string; baseUrl?: string }): {
  collection(name: string): {
    get(id: string): Promise<Document>;
    list(options?: {
      limit?: number;
      after?: string;
    }): Promise<{ documents: Document[]; nextCursor: string | null }>;
    add(data: Json): Promise<{ id: string }>;
    set(id: string, data: Json): Promise<{ id: string }>;
    delete(id: string): Promise<{ success: true }>;
  };
};
