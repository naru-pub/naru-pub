import type { ErrorCode } from "../../control-plane/src/lib/site-data/validation";

// What crosses the boundary of a site's Durable Object (site.ts): the
// arguments of its RPC methods and what they answer. The control plane sends
// these as JSON through /v1/sites (index.ts); website.ts calls `serve`.

/** What the control plane decided about the caller before calling in. */
export type Access = {
  /** The site's owner, signed in to the control panel or through a token. */
  admin: boolean;
  /** Collections a website token may use; null without a token. */
  allowedIds: string[] | null;
  /** No credential at all: a visitor. Only such reads may be cached. */
  anonymous: boolean;
};

export type ExecuteInput = {
  ownerId: string;
  access: Access;
  path: string[];
  method: string;
  body?: Record<string, unknown>;
  filter?: unknown;
  size?: number;
  sort?: string;
  after?: string;
  includeTotal?: boolean;
  ifVersion?: unknown;
  clientIp?: string;
};

/** What a list read takes beyond the collection it reads. */
export type ListInput = Pick<
  ExecuteInput,
  "filter" | "size" | "sort" | "after" | "includeTotal"
>;

export type Collection = {
  id: string;
  name: string;
  read_access: string;
  write_access: string;
};

/** A document as `export` and `import` carry it; times are epoch ms. */
export type StoredDocument = {
  collection_id: string;
  id: string;
  data: string;
  size_bytes: number;
  version: number;
  created_at: number;
  updated_at: number;
};

export type Snapshot = {
  ownerId: string | null;
  collections: Collection[];
  documents: StoredDocument[];
};

/** Errors cross the RPC boundary as values: a thrown error loses its fields. */
export type Outcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        status: number;
        message: string;
        code?: ErrorCode;
        /** Set when the monthly budget is spent: when it resets, epoch ms. */
        resetsAt?: number;
      };
    };

/** A request the object answers itself, at the edge, for a visitor. */
export type ServeInput = Omit<ExecuteInput, "ownerId" | "access">;
/** Answered, or to be sent on to the control plane. */
export type Served =
  | { pass: true }
  | { pass?: undefined; result: unknown; publicRead: boolean };

/**
 * What the control plane keeps current in the object of each site with the
 * database feature, so the edge can make PostgreSQL's paid-status check.
 */
export type EdgeConfiguration = {
  ownerId: string;
  /** When the site's database feature ends, epoch ms; null never. */
  entitledUntil: number | null;
  /**
   * Until when that is known to be current, epoch ms: the control plane
   * renews it on every sync. Past it the object answers no visitor and the
   * control plane decides, so a revoked feature or a stopped sync is never
   * served from a stale date.
   */
  confirmedUntil: number;
  /** A budget other than the Worker's default; null restores the default. */
  monthlyRequests?: number | null;
};

export type Usage = { documents: number; bytes: number };
