import { DurableObject } from "cloudflare:workers";
import { createHash, randomUUID } from "node:crypto";
import {
  authorize,
  DataError,
  MAX_COLLECTIONS,
  MAX_DOCUMENTS,
  MAX_DOCUMENT_BYTES,
  MAX_SITE_BYTES,
  name,
  permission,
  unreservedName,
  writePermission,
} from "../../control-plane/src/lib/site-data/validation";
import { uuidv7 } from "../../control-plane/src/lib/uuid";
import {
  documentOf,
  listQuery,
  SCHEMA,
  type Row,
  type SqlValue,
} from "./query";
import type {
  Collection,
  EdgeConfiguration,
  ExecuteInput,
  ListInput,
  Outcome,
  ServeInput,
  Served,
  Snapshot,
  Usage,
} from "./types";

// One site's collections and documents, stored in SQLite: the request rules
// and storage. Its arguments and answers are in types.ts, its list query in
// query.ts. The control plane uses the same validation, filter and cursor
// modules.
// What lives in PostgreSQL stays there: the control plane resolves the owner,
// paid status and sign-in scope, then calls in with the outcome (`Access`).
//
// A Durable Object runs one request at a time, and every method here is
// synchronous inside `transactionSync`, so the object needs no owner-row lock
// or write queue: each request sees and leaves a consistent site.

const outsideScope = (collection: string) =>
  new DataError(
    403,
    `Collection ${collection} was not approved for this sign-in. Add it to signIn({ collections }) and sign in again.`,
    "ACCESS_DENIED",
  );
const unsupported = () =>
  new DataError(400, "Data contains unsupported characters or numbers.");
/** Anonymous requests a site may make each calendar month (UTC). */
const DEFAULT_MONTHLY_REQUESTS = 500_000;
/** The count is kept in memory and written every this many requests. */
const BUDGET_SAVE_EVERY = 25;

class BudgetSpent extends DataError {
  constructor(
    limit: number,
    public resetsAt: number,
  ) {
    super(
      429,
      `This site has used its ${limit.toLocaleString("en-US")} database requests for the month. They resume on ${new Date(resetsAt).toISOString().slice(0, 10)}.`,
      "RATE_LIMITED",
    );
  }
}
const nextMonth = (now: Date) =>
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
const rateLimited = () =>
  new DataError(429, "Public write rate limit reached. Try again next minute.");

function deletable(expected: number | undefined) {
  if (expected === 0)
    throw new DataError(400, "A delete can only be conditional on a revision.");
}
function expectedVersion(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new DataError(400, "ifVersion must be a non-negative integer.");
  return value;
}
function matchVersion(expected: number, actual: number | undefined) {
  if (expected === (actual ?? 0)) return;
  throw new DataError(
    409,
    expected === 0
      ? "The document already exists."
      : actual === undefined
        ? "The document was deleted after that revision was read."
        : "The document changed after that revision was read. Read it again before saving.",
    "CONFLICT",
  );
}

/** The v1 data contract rejects NUL and unpaired surrogates, in keys too. */
function storable(value: unknown): void {
  if (typeof value === "string") {
    if (value.includes("\u0000") || !value.isWellFormed()) throw unsupported();
  } else if (Array.isArray(value)) value.forEach(storable);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      storable(key);
      storable(item);
    }
}
function encode(data: unknown) {
  storable(data);
  const encoded = JSON.stringify(data);
  const size = Buffer.byteLength(encoded);
  if (size > MAX_DOCUMENT_BYTES)
    throw new DataError(413, "Document exceeds 64 KiB.");
  return { encoded, size };
}

export class SiteData extends DurableObject<Env> {
  private sql: SqlStorage;
  /** This month's anonymous requests, ahead of what is saved in `meta`. */
  private budget?: { month: string; used: number; unsaved: number };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.createTables();
  }

  private createTables() {
    this.sql.exec(SCHEMA);
  }
  private run<T>(work: () => T): Outcome<T> {
    try {
      return { ok: true, value: this.ctx.storage.transactionSync(work) };
    } catch (error) {
      if (error instanceof DataError)
        return {
          ok: false,
          error: {
            status: error.status,
            message: error.message,
            code: error.code,
            ...(error instanceof BudgetSpent
              ? { resetsAt: error.resetsAt }
              : {}),
          },
        };
      throw error;
    }
  }

  private rows(query: string, ...bindings: SqlValue[]): Row[] {
    return this.sql.exec(query, ...bindings).toArray() as Row[];
  }

  private meta(key: string): string | null {
    return (this.rows("SELECT value FROM meta WHERE key = ?", key)[0]?.value ??
      null) as string | null;
  }

  private setMeta(key: string, value: string | null) {
    if (value === null) this.sql.exec("DELETE FROM meta WHERE key = ?", key);
    else
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        key,
        value,
      );
  }

  /** The object belongs to one account; a second would be a routing bug. */
  private claim(ownerId: string) {
    const current = this.meta("owner_id");
    if (current === null) this.setMeta("owner_id", ownerId);
    else if (current !== ownerId)
      throw new DataError(503, "Site storage belongs to another account.");
  }

  private collection(id: string, row: Row) {
    return { id, user_id: this.meta("owner_id"), ...row };
  }

  private usage() {
    const row = this.rows(
      "SELECT count(*) AS documents, coalesce(sum(size_bytes), 0) AS bytes FROM documents",
    )[0];
    return { documents: Number(row.documents), bytes: Number(row.bytes) };
  }

  /** Fixed-minute buckets: 60 public writes per site, 20 per caller. */
  private limitPublicWrite(clientIp?: string) {
    const window = Math.floor(Date.now() / 60000) * 60000;
    this.sql.exec("DELETE FROM rate_limits WHERE window_start < ?", window);
    const caller = createHash("sha256")
      .update(clientIp || "unknown")
      .digest("base64url");
    for (const [key, maximum] of [
      ["site", 60],
      [`ip:${caller}`, 20],
    ] as const) {
      const count = Number(
        this.rows("SELECT count FROM rate_limits WHERE key = ?", key)[0]
          ?.count ?? 0,
      );
      if (count >= maximum) throw rateLimited();
      this.sql.exec(
        "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET count = count + 1",
        key,
        window,
      );
    }
  }

  private written(collectionId: string, id: string) {
    const row = this.rows(
      "SELECT data, version, created_at, updated_at FROM documents WHERE collection_id = ? AND id = ?",
      collectionId,
      id,
    )[0];
    return {
      data: JSON.parse(row.data as string),
      version: Number(row.version),
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
    };
  }

  private upsert(
    collectionId: string,
    id: string,
    encoded: string,
    size: number,
  ) {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO documents (collection_id, id, data, size_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (collection_id, id) DO UPDATE SET data = excluded.data,
         size_bytes = excluded.size_bytes, updated_at = excluded.updated_at,
         version = documents.version + 1`,
      collectionId,
      id,
      encoded,
      size,
      now,
      now,
    );
  }

  private monthlyLimit() {
    const own = this.meta("monthly_requests");
    if (own !== null) return Number(own);
    const configured = Number(
      (this.env as { SITE_MONTHLY_REQUESTS?: string }).SITE_MONTHLY_REQUESTS,
    );
    return configured > 0 ? configured : DEFAULT_MONTHLY_REQUESTS;
  }

  /**
   * Counts one anonymous request against the month, or refuses it once the
   * month's budget is spent. Owners are never counted. Run on its own, not in
   * the request's transaction: a request that then fails was still served.
   * Losing up to BUDGET_SAVE_EVERY counts when the object is evicted is the
   * price of not writing on every read.
   */
  private spend() {
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    if (!this.budget || this.budget.month !== month)
      this.budget = {
        month,
        used:
          this.meta("budget_month") === month
            ? Number(this.meta("budget_used"))
            : 0,
        unsaved: 0,
      };
    const limit = this.monthlyLimit();
    if (this.budget.used >= limit) throw new BudgetSpent(limit, nextMonth(now));
    this.budget.used += 1;
    this.budget.unsaved += 1;
    if (this.budget.unsaved >= BUDGET_SAVE_EVERY) {
      this.setMeta("budget_month", month);
      this.setMeta("budget_used", String(this.budget.used));
      this.budget.unsaved = 0;
    }
  }

  /**
   * A collection or document request the control plane admitted: from the
   * control panel, a signed-in website, or a visitor the edge sent on.
   */
  async execute(input: ExecuteInput) {
    if (input.access.anonymous) {
      const spent = this.run(() => this.spend());
      if (!spent.ok) return spent;
    }
    return this.run(() => this.executeSync(input));
  }

  /**
   * An anonymous request at the edge. The object answers it only while the
   * site has the database feature by the control plane's confirmed date
   * (`configure`). Otherwise the Worker sends the request on and the control
   * plane decides from PostgreSQL, which never lags: a site whose feature
   * has ended is refused there, and one whose owner just paid again is
   * served without waiting for the next sync.
   */
  async serve(input: ServeInput): Promise<Outcome<Served>> {
    const ownerId = this.meta("owner_id");
    const until = this.meta("entitled_until");
    const confirmed = Number(this.meta("confirmed_until") ?? 0);
    const now = Date.now();
    if (
      ownerId === null ||
      until === null ||
      confirmed <= now ||
      (until !== "forever" && Number(until) <= now)
    )
      return { ok: true, value: { pass: true } };
    const spent = this.run(() => this.spend());
    if (!spent.ok) return spent;
    return this.run(() => {
      if (input.path.length > 2) throw new DataError(404, "Not found.");
      input.path.forEach(name);
      return this.executeSync({
        ...input,
        ownerId,
        access: { admin: false, allowedIds: null, anonymous: true },
      });
    });
  }

  /** Sets what `serve` relies on (see EdgeConfiguration); reports usage. */
  async configure(input: EdgeConfiguration): Promise<Outcome<Usage>> {
    return this.run(() => {
      this.claim(input.ownerId);
      this.setMeta(
        "entitled_until",
        input.entitledUntil === null ? "forever" : String(input.entitledUntil),
      );
      this.setMeta("confirmed_until", String(input.confirmedUntil));
      if (input.monthlyRequests !== undefined)
        this.setMeta(
          "monthly_requests",
          input.monthlyRequests === null ? null : String(input.monthlyRequests),
        );
      return this.usage();
    });
  }

  private executeSync(input: ExecuteInput) {
    const { path, method, access } = input;
    const body = input.body ?? {};
    const reading = method === "GET";
    this.claim(input.ownerId);
    const { admin, allowedIds } = access;
    let publicRead = false;
    if (!path.length) {
      if (allowedIds !== null)
        throw new DataError(403, "Website tokens only allow document access.");
      if (!admin) throw new DataError(403, "Admin access required.");
      if (method === "GET")
        return {
          result: {
            collections: this.rows(
              "SELECT id, name, read_access, write_access FROM collections ORDER BY name",
            ).map((row) => this.collection(row.id as string, row)),
          },
          publicRead,
        };
      if (method !== "POST") throw new DataError(405, "Method not allowed.");
      const collectionName = unreservedName(body.name);
      if (
        this.rows("SELECT id FROM collections WHERE name = ?", collectionName)
          .length
      )
        throw new DataError(409, "Collection exists.");
      if (
        Number(
          this.rows("SELECT count(*) AS count FROM collections")[0].count,
        ) >= MAX_COLLECTIONS
      )
        throw new DataError(409, "Collection limit reached.", "QUOTA_EXCEEDED");
      const created = {
        name: collectionName,
        read_access: permission(body.read ?? "admin"),
        write_access: writePermission(body.write ?? "admin"),
      };
      const id = uuidv7();
      this.sql.exec(
        "INSERT INTO collections (id, name, read_access, write_access) VALUES (?, ?, ?, ?)",
        id,
        created.name,
        created.read_access,
        created.write_access,
      );
      return {
        result: { collection: this.collection(id, created) },
        publicRead,
      };
    }
    const found = this.rows(
      "SELECT id, name, read_access, write_access FROM collections WHERE name = ?",
      path[0],
    )[0];
    if (!found)
      throw new DataError(
        404,
        `Collection ${path[0]} does not exist. Create it in the control panel.`,
      );
    const collection = found as unknown as Collection;
    if (allowedIds !== null && !allowedIds.includes(collection.id))
      throw outsideScope(collection.name);
    if (path.length === 1 && (method === "PATCH" || method === "DELETE")) {
      if (allowedIds !== null)
        throw new DataError(403, "Website tokens cannot manage collections.");
      if (!admin) throw new DataError(403, "Admin access required.");
      if (method === "DELETE") {
        this.sql.exec(
          "DELETE FROM documents WHERE collection_id = ?",
          collection.id,
        );
        this.sql.exec("DELETE FROM collections WHERE id = ?", collection.id);
        return { result: { success: true }, publicRead };
      }
      const updated = {
        name: collection.name,
        read_access: permission(body.read),
        write_access: writePermission(body.write),
      };
      this.sql.exec(
        "UPDATE collections SET read_access = ?, write_access = ? WHERE id = ?",
        updated.read_access,
        updated.write_access,
        collection.id,
      );
      return {
        result: { collection: this.collection(collection.id, updated) },
        publicRead,
      };
    }
    if (method === "GET") {
      authorize(
        collection.read_access,
        admin,
        `Collection ${collection.name} is not publicly readable. Change its read access in the control panel, or sign in.`,
      );
      // Identical rows for any stranger, so a shared cache may hold them.
      publicRead = collection.read_access === "world" && access.anonymous;
      if (path.length === 2) {
        const row = this.rows(
          "SELECT id, data, version, created_at, updated_at FROM documents WHERE collection_id = ? AND id = ?",
          collection.id,
          path[1],
        )[0];
        if (!row) throw new DataError(404, "Document not found.");
        return { result: { document: documentOf(row) }, publicRead };
      }
      return { result: this.list(collection, input), publicRead };
    }
    const creating = method === "POST" && path.length === 1;
    if (!(creating && collection.write_access === "create"))
      authorize(
        collection.write_access,
        admin,
        creating
          ? `Visitors cannot add to collection ${collection.name}. Change its write access in the control panel, or sign in.`
          : `Only a signed-in owner can change documents in collection ${collection.name}.`,
      );
    // Every write past this point is reachable without an owner credential
    // when the collection allows it, so all of them are counted.
    if (!admin) this.limitPublicWrite(input.clientIp);
    const expected = expectedVersion(input.ifVersion);
    const current = (id: string) =>
      this.rows(
        "SELECT size_bytes, version FROM documents WHERE collection_id = ? AND id = ?",
        collection.id,
        id,
      )[0] as { size_bytes: number; version: number } | undefined;
    if (method === "DELETE" && path.length === 2) {
      deletable(expected);
      if (expected !== undefined)
        matchVersion(expected, current(path[1])?.version);
      this.sql.exec(
        "DELETE FROM documents WHERE collection_id = ? AND id = ?",
        collection.id,
        path[1],
      );
      return { result: { success: true }, publicRead };
    }
    if (!(creating || (method === "PUT" && path.length === 2)))
      throw new DataError(405, "Method not allowed.");
    if (!Object.hasOwn(body, "data"))
      throw new DataError(400, "data is required.");
    const id = path[1] ?? randomUUID();
    const existing = current(id);
    if (expected !== undefined) matchVersion(expected, existing?.version);
    const { encoded, size } = encode(body.data);
    const usage = this.usage();
    if (
      usage.bytes - Number(existing?.size_bytes ?? 0) + size > MAX_SITE_BYTES ||
      (!existing && usage.documents >= MAX_DOCUMENTS)
    )
      throw new DataError(
        409,
        "Site database quota exceeded.",
        "QUOTA_EXCEEDED",
      );
    // Never overwrite on create, even in the event of an ID collision.
    if (creating && existing)
      throw new DataError(409, "Document ID collision. Retry creation.");
    this.upsert(collection.id, id, encoded, size);
    return { result: { id, ...this.written(collection.id, id) }, publicRead };
  }

  private list(collection: Collection, input: ListInput) {
    const query = listQuery(collection.id, input);
    const rows = this.rows(query.select.sql, ...query.select.bindings);
    const totalCount = query.count
      ? Number(this.rows(query.count.sql, ...query.count.bindings)[0].matched)
      : undefined;
    return { ...query.page(rows), totalCount };
  }

  /** A `_batch` of sets and deletes from the owner, all or nothing. */
  async batch(input: {
    ownerId: string;
    allowedIds: string[] | null;
    operations: unknown[];
  }) {
    return this.run(() => {
      this.claim(input.ownerId);
      const collections = this.rows(
        "SELECT id, name, read_access, write_access FROM collections",
      ) as unknown as Collection[];
      const results = [];
      for (const raw of input.operations) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new DataError(400, "Invalid batch operation.");
        const operation = raw as Record<string, unknown>;
        const collectionName = name(operation.collection);
        const id = name(operation.id);
        const collection = collections.find(
          (row) => row.name === collectionName,
        );
        if (!collection)
          throw new DataError(
            404,
            `Collection ${collectionName} does not exist. Create it in the control panel.`,
          );
        if (
          input.allowedIds !== null &&
          !input.allowedIds.includes(collection.id)
        )
          throw outsideScope(collectionName);
        authorize(collection.write_access, true);
        const expected = expectedVersion(operation.ifVersion);
        if (operation.type === "delete") deletable(expected);
        if (expected !== undefined)
          matchVersion(
            expected,
            (
              this.rows(
                "SELECT version FROM documents WHERE collection_id = ? AND id = ?",
                collection.id,
                id,
              )[0] as { version: number } | undefined
            )?.version,
          );
        if (operation.type === "delete") {
          this.sql.exec(
            "DELETE FROM documents WHERE collection_id = ? AND id = ?",
            collection.id,
            id,
          );
          results.push(null);
          continue;
        }
        if (operation.type !== "set" || !Object.hasOwn(operation, "data"))
          throw new DataError(400, "Batch operations must be set or delete.");
        const { encoded, size } = encode(operation.data);
        this.upsert(collection.id, id, encoded, size);
        const { version, createdAt, updatedAt } = this.written(
          collection.id,
          id,
        );
        // Metadata only: the caller already holds the data it wrote.
        results.push({ id, version, createdAt, updatedAt });
      }
      // Checked once at the end: a batch may
      // pass through a larger total on its way to a smaller one.
      const usage = this.usage();
      if (usage.bytes > MAX_SITE_BYTES || usage.documents > MAX_DOCUMENTS)
        throw new DataError(
          409,
          "Site database quota exceeded.",
          "QUOTA_EXCEEDED",
        );
      return { success: true, results };
    });
  }

  /** The named collections, or all of them, ordered by name. */
  async collections(input: { names?: string[] }) {
    return this.run(() => {
      const rows = this.rows(
        "SELECT id, name, read_access, write_access FROM collections ORDER BY name",
      ) as unknown as Collection[];
      return input.names
        ? rows.filter((row) => input.names!.includes(row.name))
        : rows;
    });
  }

  /**
   * Creates the missing collections, empty, or none (null) when they would
   * pass the collection limit. Returns the names it created.
   */
  async createCollections(input: {
    ownerId: string;
    collections: Omit<Collection, "id">[];
  }) {
    return this.run(() => {
      if (!input.collections.length) return [];
      this.claim(input.ownerId);
      const count = Number(
        this.rows("SELECT count(*) AS count FROM collections")[0].count,
      );
      if (count + input.collections.length > MAX_COLLECTIONS) return null;
      const created: string[] = [];
      for (const collection of input.collections) {
        const inserted = this.rows(
          `INSERT INTO collections (id, name, read_access, write_access) VALUES (?, ?, ?, ?)
           ON CONFLICT (name) DO NOTHING RETURNING name`,
          uuidv7(),
          collection.name,
          collection.read_access,
          collection.write_access,
        );
        if (inserted.length) created.push(collection.name);
      }
      return created;
    });
  }

  async export(): Promise<Outcome<Snapshot>> {
    return this.run(() => ({
      ownerId: this.meta("owner_id"),
      collections: this.rows(
        "SELECT id, name, read_access, write_access FROM collections ORDER BY id",
      ) as unknown as Collection[],
      documents: this.rows(
        `SELECT collection_id, id, data, size_bytes, version, created_at, updated_at
         FROM documents ORDER BY collection_id, id`,
      ).map((row) => ({
        collection_id: row.collection_id as string,
        id: row.id as string,
        data: row.data as string,
        size_bytes: Number(row.size_bytes),
        version: Number(row.version),
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
      })),
    }));
  }

  /**
   * Replaces the whole site with `snapshot`, keeping its ids. For restoring
   * an `export`, and for tests; the control plane's configuration goes too.
   */
  async import(snapshot: Snapshot) {
    return this.run(() => {
      this.sql.exec("DELETE FROM documents");
      this.sql.exec("DELETE FROM collections");
      this.sql.exec("DELETE FROM rate_limits");
      this.sql.exec("DELETE FROM meta");
      this.budget = undefined;
      if (snapshot.ownerId !== null) this.setMeta("owner_id", snapshot.ownerId);
      for (const collection of snapshot.collections)
        this.sql.exec(
          "INSERT INTO collections (id, name, read_access, write_access) VALUES (?, ?, ?, ?)",
          collection.id,
          collection.name,
          collection.read_access,
          collection.write_access,
        );
      for (const document of snapshot.documents)
        this.sql.exec(
          `INSERT INTO documents (collection_id, id, data, size_bytes, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          document.collection_id,
          document.id,
          document.data,
          document.size_bytes,
          document.version,
          document.created_at,
          document.updated_at,
        );
    });
  }

  /** Erases the site, for account deletion. */
  async erase(): Promise<Outcome<null>> {
    await this.ctx.storage.deleteAll();
    this.budget = undefined;
    // deleteAll drops the tables too; this instance may serve again.
    this.createTables();
    return { ok: true, value: null };
  }
}
