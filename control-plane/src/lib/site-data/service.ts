import { randomUUID } from "node:crypto";
import { sql, type RawBuilder } from "kysely";
import { db, requestDeadline } from "@/lib/database";
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
} from "./validation";
import { COMPARISONS, filters } from "./filters";
import {
  sortings,
  decodeCursor,
  encodeCursor,
  decodeMultiCursor,
  encodeMultiCursor,
} from "./pagination";
import {
  tokenScope,
  limitPublicWrite,
  refusePublicWriteOverLimit,
} from "./owner-auth";
import { userHasFeature } from "@/lib/entitlements";
import { siteDataWriteAdmission } from "./write-admission";

export type DataCommand = {
  site: string;
  path: string[];
  method: string;
  adminUserId?: string;
  // Mutable: tokenScope reports the expiry the renewed token now has.
  bearer?: { token: string; origin: string | null; expiresAt?: number };
  clientIp?: string;
  /** Cancels waiting for write admission; an executing transaction still settles. */
  signal?: AbortSignal;
  body?: Record<string, unknown>;
  /** Opaque cursor from the preceding page's nextCursor. */
  after?: string;
  size?: number;
  /** JSON array of one or two [field, direction] pairs. */
  sort?: string;
  filter?: unknown;
  includeTotal?: boolean;
  ifVersion?: number;
  /**
   * Filled in by the service when the response it produced is one any stranger
   * could have fetched, so the transport can let it be cached. Reported rather
   * than returned because it is metadata about the response, not part of it.
   */
  cacheability?: { public: boolean };
};

/** Server metadata is camelCase on the wire; the columns stay snake_case. */
const TIMESTAMPS = [
  sql<Date>`created_at`.as("createdAt"),
  sql<Date>`updated_at`.as("updatedAt"),
];
/** Every accepted write reports the version a later conditional write quotes
 * and the stamps a caller renders, so it never guesses a timestamp. */
const WRITTEN = ["data", "version", "created_at", "updated_at"] as const;
/** "Delete only if absent" could only ever do nothing, so it is refused. */
function deletable(expected: number | undefined) {
  if (expected === 0)
    throw new DataError(400, "A delete can only be conditional on a revision.");
}

/** `0` asserts the document does not exist yet, so a create cannot clobber. */
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
/** A collection a sign-in did not ask for, named with how to get it. */
const outsideScope = (name: string) =>
  new DataError(
    403,
    `Collection ${name} was not approved for this sign-in. Add it to signIn({ collections }) and sign in again.`,
    "ACCESS_DENIED",
  );
const noSite = (site: string) =>
  new DataError(404, `No Naru site is named ${site}.`);
/** Naru ordering: null/missing/non-scalars, strings, numbers, booleans.
 * Explicit keys keep the contract independent of JSONB ordering and locale.
 * Every component is non-null so cursor comparisons form a total order. */
function scalarOrder(value: RawBuilder<unknown>) {
  return sql`ROW(
    CASE jsonb_typeof(${value}) WHEN 'string' THEN 1 WHEN 'number' THEN 2 WHEN 'boolean' THEN 3 ELSE 0 END,
    (CASE WHEN jsonb_typeof(${value}) = 'string' THEN ${value} #>> '{}' ELSE '' END) COLLATE "C",
    CASE WHEN jsonb_typeof(${value}) = 'number' THEN (${value})::numeric ELSE 0 END,
    CASE WHEN jsonb_typeof(${value}) = 'boolean' THEN (${value})::boolean ELSE false END
  )`;
}
const ID_ORDER = sql`id COLLATE "C"`;

/** Filters address top-level fields of a document's `data`. */
function filterConditions(filter: ReturnType<typeof filters>) {
  const target = sql.ref("data");
  const conditions = [];
  if (filter.entries.length) {
    // GIN finds candidates; equality checks enforce exact scalar semantics,
    // so arrays containing a scalar never count as a scalar field match.
    conditions.push(sql<boolean>`${target} @> ${filter.json}::jsonb`);
    for (const [field, value] of filter.entries)
      conditions.push(
        sql<boolean>`${target} -> ${field} = ${JSON.stringify(value)}::jsonb`,
      );
  }
  for (const [field, operator, bound] of filter.ranges) {
    // JSONB orders numbers above strings, so ranges compare within one type
    // only. Comparing JSONB rather than a cast never raises on other types.
    const value = sql`${target} -> ${field}`;
    conditions.push(sql<boolean>`jsonb_typeof(${value}) = ${typeof bound}`);
    conditions.push(
      typeof bound === "string"
        ? sql<boolean>`(${target} ->> ${field}) COLLATE "C" ${sql.raw(COMPARISONS[operator])} ${bound}`
        : sql<boolean>`${value} ${sql.raw(COMPARISONS[operator])} ${JSON.stringify(bound)}::jsonb`,
    );
  }
  return conditions;
}

export async function executeData(command: DataCommand) {
  if (command.method === "GET") return executeAdmittedData(command);
  return siteDataWriteAdmission.run(command.site, command.signal, () =>
    executeAdmittedData(command),
  );
}

async function executeAdmittedData(command: DataCommand) {
  const { site, path, method, adminUserId, body = {} } = command;
  if (path.length > 2) throw new DataError(404, "Not found.");
  path.forEach(name);
  const reading = method === "GET";
  // Only a write with no credential at all is ever rate limited, so only that
  // one is turned away early; everything else goes on to be authorized.
  if (
    !reading &&
    path.length > 0 &&
    command.bearer === undefined &&
    adminUserId === undefined
  )
    await refusePublicWriteOverLimit(site, command.clientIp);
  return db.transaction().execute(async (tx) => {
    await requestDeadline(tx);
    // Writes lock the owner row, so rules, quota checks and document writes are
    // serialized across processes, including concurrent collection deletion.
    // Reads take no lock: they happen on every visitor pageview of a site that
    // uses the SDK, and serializing those behind one row would queue a popular
    // site's whole audience on a single lock while each waiter holds a pool
    // connection the rest of the control plane also needs.
    const ownerQuery = tx
      .selectFrom("users")
      .select(["id", "site_data_document_count", "site_data_bytes_used"])
      .where("login_name", "=", site);
    const owner = await (
      reading ? ownerQuery : ownerQuery.forUpdate()
    ).executeTakeFirst();
    if (!owner) throw noSite(command.site);
    // `tx`, never the pool: this runs inside the transaction, and taking a
    // second connection while holding the first is how the pool deadlocks.
    if (!(await userHasFeature(owner.id, "database", tx)))
      throw new DataError(403, "Database access is not enabled for this site.");
    const allowedIds = command.bearer
      ? await tokenScope(tx, owner.id, command.bearer)
      : undefined;
    const admin = adminUserId === owner.id || allowedIds !== undefined;
    if (adminUserId !== undefined && !admin)
      throw new DataError(403, "Permission denied.");
    const collections = () =>
      tx.selectFrom("site_data_collections").where("user_id", "=", owner.id);
    if (!path.length) {
      if (allowedIds !== undefined)
        throw new DataError(403, "Website tokens only allow document access.");
      if (!admin) throw new DataError(403, "Admin access required.");
      if (method === "GET")
        return {
          collections: await collections()
            .selectAll()
            .orderBy("name")
            .execute(),
        };
      if (method !== "POST") throw new DataError(405, "Method not allowed.");
      const collectionName = unreservedName(body.name);
      if (
        await collections()
          .where("name", "=", collectionName)
          .select("id")
          .executeTakeFirst()
      )
        throw new DataError(409, "Collection exists.");
      const count = await collections()
        .select(tx.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= MAX_COLLECTIONS)
        throw new DataError(409, "Collection limit reached.", "QUOTA_EXCEEDED");
      const collection = await tx
        .insertInto("site_data_collections")
        .values({
          user_id: owner.id,
          name: collectionName,
          read_access: permission(body.read ?? "admin"),
          write_access: writePermission(body.write ?? "admin"),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { collection };
    }
    const collection = await collections()
      .where("name", "=", path[0])
      .selectAll()
      .executeTakeFirst();
    if (!collection)
      throw new DataError(
        404,
        `Collection ${path[0]} does not exist. Create it in the control panel.`,
      );
    if (allowedIds !== undefined && !allowedIds.includes(collection.id))
      throw outsideScope(collection.name);
    if (path.length === 1 && (method === "PATCH" || method === "DELETE")) {
      if (allowedIds !== undefined)
        throw new DataError(403, "Website tokens cannot manage collections.");
      if (!admin) throw new DataError(403, "Admin access required.");
      if (method === "DELETE") {
        await tx
          .deleteFrom("site_data_collections")
          .where("id", "=", collection.id)
          .execute();
        return { success: true };
      }
      const updated = await tx
        .updateTable("site_data_collections")
        .where("id", "=", collection.id)
        .set({
          read_access: permission(body.read),
          write_access: writePermission(body.write),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { collection: updated };
    }
    const documents = () =>
      tx
        .selectFrom("site_data_documents")
        .where("collection_id", "=", collection.id);
    if (method === "GET") {
      authorize(
        collection.read_access,
        admin,
        `Collection ${collection.name} is not publicly readable. Change its read access in the control panel, or sign in.`,
      );
      // A world-readable collection returns identical rows whoever asks, so an
      // anonymous read of one is safe for a shared cache to hold and replay.
      // Requests carrying a credential are never marked: an intermediary that
      // ignores Vary would otherwise be able to serve one caller's authorized
      // response to somebody else.
      if (
        collection.read_access === "world" &&
        command.bearer === undefined &&
        adminUserId === undefined &&
        command.cacheability
      )
        command.cacheability.public = true;
      if (path.length === 2) {
        const document = await documents()
          .where("id", "=", path[1])
          .select(["id", "data", "version"])
          .select(TIMESTAMPS)
          .executeTakeFirst();
        if (!document) throw new DataError(404, "Document not found.");
        return { document };
      }
      const filter = filters(command.filter);
      const conditions = filterConditions(filter);
      const limit = command.size ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new DataError(400, "Page size must be 1–100.");
      const sorts = sortings(command.sort);
      const sort = sorts[0];
      const multiple = sorts.length > 1;
      const cursor = multiple
        ? decodeMultiCursor(
            command.after,
            collection.id,
            sorts,
            filter.fingerprint,
          )
        : decodeCursor(command.after, collection.id, sort, filter.fingerprint);
      const rawValues = sorts.map((item) =>
        item.field
          ? sql`coalesce(data -> ${item.field}, 'null'::jsonb)`
          : sql.ref(item.column),
      );
      const sortValues = sorts.map((item, index) =>
        item.field
          ? scalarOrder(rawValues[index])
          : item.orderBy === "id"
            ? ID_ORDER
            : rawValues[index],
      );
      const sortValue = sortValues[0];
      let query = documents()
        .select(["id", "data", "version"])
        .select(TIMESTAMPS);
      for (let index = 0; index < sorts.length; index += 1) {
        const item = sorts[index];
        const value = sortValues[index];
        query = query.select(
          (item.orderBy === "id"
            ? sql<string | null>`null`
            : item.field
              ? sql<string>`(${rawValues[index]})::text`
              : sql<string>`to_char(${value} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
          ).as(`cursor_value_${index}`),
        );
        query = query.orderBy(value, item.direction);
      }
      query = query.limit(limit + 1);
      for (const condition of conditions) query = query.where(condition);
      if (!sorts.some((item) => item.orderBy === "id"))
        query = query.orderBy(ID_ORDER, sorts.at(-1)!.direction);
      if (cursor) {
        if (!multiple) {
          const single = cursor as { id: string; value: string | null };
          const comparison = sort.direction === "asc" ? ">" : "<";
          if (sort.orderBy === "id")
            query = query.where(ID_ORDER, comparison, single.id);
          else
            query = query.where(
              sql<boolean>`(${sortValue}, ${ID_ORDER}) ${sql.raw(comparison)} (${
                sort.field
                  ? scalarOrder(sql`${single.value}::jsonb`)
                  : sql`${single.value}::timestamptz`
              }, ${single.id})`,
            );
        } else {
          const multi = cursor as { id: string; values: string[] };
          const cursorValues = sorts.map((item, index) =>
            item.field
              ? scalarOrder(sql`${multi.values[index]}::jsonb`)
              : sql`${multi.values[index]}::timestamptz`,
          );
          const branches = sorts.map((item, index) => {
            const equal = sortValues
              .slice(0, index)
              .map(
                (value, before) =>
                  sql<boolean>`${value} = ${cursorValues[before]}`,
              );
            const comparison = item.direction === "asc" ? ">" : "<";
            return sql<boolean>`(${sql.join(
              [
                ...equal,
                sql<boolean>`${sortValues[index]} ${sql.raw(comparison)} ${cursorValues[index]}`,
              ],
              sql` and `,
            )})`;
          });
          const idComparison = sorts.at(-1)!.direction === "asc" ? ">" : "<";
          branches.push(
            sql<boolean>`(${sql.join(
              [
                ...sortValues.map(
                  (value, index) =>
                    sql<boolean>`${value} = ${cursorValues[index]}`,
                ),
                sql<boolean>`${ID_ORDER} ${sql.raw(idComparison)} ${multi.id}`,
              ],
              sql` and `,
            )})`,
          );
          query = query.where(sql<boolean>`(${sql.join(branches, sql` or `)})`);
        }
      }
      type ListedRow = {
        id: string;
        data: unknown;
        version: number;
        createdAt: Date;
        updatedAt: Date;
        cursor_value_0?: string | null;
        cursor_value_1?: string | null;
      };
      let rows: ListedRow[];
      let totalCount: number | undefined;
      if (command.includeTotal) {
        let counter = documents().select(
          tx.fn.countAll<string>().as("matched"),
        );
        for (const condition of conditions) counter = counter.where(condition);
        // One SQL statement gives the page and count the same snapshot without
        // changing isolation or retrying the owner-token renewal transaction.
        const result = await tx
          .selectNoFrom([
            sql<
              ListedRow[]
            >`coalesce((select json_agg(page) from (${query}) as page), '[]'::json)`.as(
              "rows",
            ),
            counter.as("total"),
          ])
          .executeTakeFirstOrThrow();
        rows = result.rows.map((row) => ({
          ...row,
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
        }));
        totalCount = Number(result.total);
      } else rows = (await query.execute()) as ListedRow[];
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        documents: page.map((row) => {
          const document = { ...row };
          delete document.cursor_value_0;
          delete document.cursor_value_1;
          return document;
        }),
        nextCursor:
          rows.length > limit && last
            ? multiple
              ? encodeMultiCursor(
                  collection.id,
                  sorts,
                  last.id,
                  sorts.map(
                    (_, index) =>
                      (index === 0
                        ? last.cursor_value_0
                        : last.cursor_value_1) as string,
                  ),
                  filter.fingerprint,
                )
              : encodeCursor(
                  collection.id,
                  sort,
                  last.id,
                  last.cursor_value_0 as string | null,
                  filter.fingerprint,
                )
            : null,
        totalCount,
      };
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
    // Every write below this point is reachable without an owner credential
    // when the collection allows it, so bound them all — not just creates.
    if (!admin) await limitPublicWrite(tx, owner.id, command.clientIp);
    const expected = expectedVersion(command.ifVersion);
    const current = (id: string) =>
      documents()
        .where("id", "=", id)
        .select(["size_bytes", "version"])
        .executeTakeFirst();
    if (method === "DELETE" && path.length === 2) {
      deletable(expected);
      if (expected !== undefined)
        // The owner row is locked, so nothing can write between check and delete.
        matchVersion(expected, (await current(path[1]))?.version);
      await tx
        .deleteFrom("site_data_documents")
        .where("collection_id", "=", collection.id)
        .where("id", "=", path[1])
        .execute();
      return { success: true };
    }
    if (!(creating || (method === "PUT" && path.length === 2)))
      throw new DataError(405, "Method not allowed.");
    if (!Object.hasOwn(body, "data"))
      throw new DataError(400, "data is required.");
    const id = path[1] ?? randomUUID();
    const existing = await current(id);
    if (expected !== undefined) matchVersion(expected, existing?.version);
    const encoded = JSON.stringify(body.data);
    const size = Buffer.byteLength(encoded);
    if (size > MAX_DOCUMENT_BYTES)
      throw new DataError(413, "Document exceeds 64 KiB.");
    if (
      Number(owner.site_data_bytes_used) - (existing?.size_bytes ?? 0) + size >
        MAX_SITE_BYTES ||
      (!existing && Number(owner.site_data_document_count) >= MAX_DOCUMENTS)
    ) {
      throw new DataError(
        409,
        "Site database quota exceeded.",
        "QUOTA_EXCEEDED",
      );
    }
    const insert = tx.insertInto("site_data_documents").values({
      collection_id: collection.id,
      id,
      data: sql`${encoded}::jsonb`,
      size_bytes: size,
    });
    let row;
    if (creating) {
      // Never overwrite a document, even in the event of an ID collision.
      row = await insert
        .onConflict((oc) => oc.columns(["collection_id", "id"]).doNothing())
        .returning(WRITTEN)
        .executeTakeFirst();
      if (!row)
        throw new DataError(409, "Document ID collision. Retry creation.");
    } else {
      row = await insert
        .onConflict((oc) =>
          oc.columns(["collection_id", "id"]).doUpdateSet({
            data: sql`${encoded}::jsonb`,
            size_bytes: size,
            updated_at: new Date(),
            // Every accepted write advances the version conditional writes quote.
            version: sql`site_data_documents.version + 1`,
          }),
        )
        .returning(WRITTEN)
        .executeTakeFirstOrThrow();
    }
    // Return only the newly stored replacement, never the previous content.
    // Create-only callers receive their own write without gaining read access.
    return {
      id,
      data: row.data,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export async function executeBatch(command: DataCommand) {
  if (command.method !== "POST")
    throw new DataError(405, "Method not allowed.");
  const operations = command.body?.operations;
  if (
    !Array.isArray(operations) ||
    !operations.length ||
    operations.length > 100
  )
    throw new DataError(400, "Batch requires 1–100 operations.");
  return siteDataWriteAdmission.run(command.site, command.signal, () =>
    executeAdmittedBatch(command, operations),
  );
}

async function executeAdmittedBatch(
  command: DataCommand,
  operations: unknown[],
) {
  return db.transaction().execute(async (tx) => {
    await requestDeadline(tx);
    // A batch is always a write, so it always takes the owner lock.
    const owner = await tx
      .selectFrom("users")
      .select("id")
      .where("login_name", "=", command.site)
      .forUpdate()
      .executeTakeFirst();
    if (!owner) throw noSite(command.site);
    // `tx`, never the pool: a second connection taken while this one is held
    // is what empties the pool under concurrency.
    if (!(await userHasFeature(owner.id, "database", tx)))
      throw new DataError(403, "Database access is not enabled for this site.");
    const allowedIds = command.bearer
      ? await tokenScope(tx, owner.id, command.bearer)
      : undefined;
    if (allowedIds === undefined && command.adminUserId !== owner.id)
      throw new DataError(403, "A batch needs an owner sign-in.");
    const collectionRows = await tx
      .selectFrom("site_data_collections")
      .selectAll()
      .where("user_id", "=", owner.id)
      .execute();
    // Distinct unconditional writes have no ordering dependencies. Preserve
    // sequential execution for repeated keys and conditional operations.
    const keys = new Set<string>();
    const bulk = operations.every((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const operation = raw as Record<string, unknown>;
      if (
        operation.ifVersion !== undefined ||
        typeof operation.collection !== "string" ||
        typeof operation.id !== "string" ||
        !(
          operation.type === "delete" ||
          (operation.type === "set" && Object.hasOwn(operation, "data"))
        )
      )
        return false;
      const key = JSON.stringify([operation.collection, operation.id]);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });
    const sets: {
      collection_id: string;
      id: string;
      data: RawBuilder<unknown>;
      size_bytes: number;
    }[] = [];
    const deletes: { collection_id: string; id: string }[] = [];
    const order: (string | null)[] = [];
    const results = [];
    for (const raw of operations) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new DataError(400, "Invalid batch operation.");
      const operation = raw as Record<string, unknown>;
      const collectionName = name(operation.collection);
      const id = name(operation.id);
      const collection = collectionRows.find(
        (row) => row.name === collectionName,
      );
      if (!collection)
        throw new DataError(
          404,
          `Collection ${collectionName} does not exist. Create it in the control panel.`,
        );
      if (allowedIds !== undefined && !allowedIds.includes(collection.id))
        throw outsideScope(collectionName);
      authorize(collection.write_access, true);
      const expected = expectedVersion(operation.ifVersion);
      if (operation.type === "delete") deletable(expected);
      // The batch holds the owner lock, so a read here cannot go stale before
      // the write that follows it.
      if (expected !== undefined)
        matchVersion(
          expected,
          (
            await tx
              .selectFrom("site_data_documents")
              .where("collection_id", "=", collection.id)
              .where("id", "=", id)
              .select("version")
              .executeTakeFirst()
          )?.version,
        );
      if (operation.type === "delete") {
        if (bulk) {
          deletes.push({ collection_id: collection.id, id });
          order.push(null);
          continue;
        }
        await tx
          .deleteFrom("site_data_documents")
          .where("collection_id", "=", collection.id)
          .where("id", "=", id)
          .execute();
        results.push(null);
        continue;
      }
      if (operation.type !== "set" || !Object.hasOwn(operation, "data"))
        throw new DataError(400, "Batch operations must be set or delete.");
      const encoded = JSON.stringify(operation.data);
      const size = Buffer.byteLength(encoded);
      if (size > MAX_DOCUMENT_BYTES)
        throw new DataError(413, "Document exceeds 64 KiB.");
      const values = {
        collection_id: collection.id,
        id,
        data: sql`${encoded}::jsonb`,
        size_bytes: size,
      };
      if (bulk) {
        sets.push(values);
        order.push(JSON.stringify([collection.id, id]));
        continue;
      }
      const insert = tx.insertInto("site_data_documents").values(values);
      const row = await insert
        .onConflict((oc) =>
          oc.columns(["collection_id", "id"]).doUpdateSet({
            data: sql`${encoded}::jsonb`,
            size_bytes: size,
            updated_at: new Date(),
            version: sql`site_data_documents.version + 1`,
          }),
        )
        .returning(["version", "created_at", "updated_at"])
        .executeTakeFirstOrThrow();
      // Metadata only: the caller already holds the data it wrote.
      results.push({
        id,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
    if (bulk) {
      if (deletes.length) {
        await tx
          .deleteFrom("site_data_documents")
          .where(({ or, and, eb }) =>
            or(
              deletes.map((item) =>
                and([
                  eb("collection_id", "=", item.collection_id),
                  eb("id", "=", item.id),
                ]),
              ),
            ),
          )
          .execute();
      }
      const rows = sets.length
        ? await tx
            .insertInto("site_data_documents")
            .values(sets)
            .onConflict((oc) =>
              oc.columns(["collection_id", "id"]).doUpdateSet({
                data: sql`excluded.data`,
                size_bytes: sql`excluded.size_bytes`,
                updated_at: new Date(),
                version: sql`site_data_documents.version + 1`,
              }),
            )
            .returning([
              "collection_id",
              "id",
              "version",
              "created_at",
              "updated_at",
            ])
            .execute()
        : [];
      // RETURNING order is not a contract; restore the caller's operation order.
      const written = new Map(
        rows.map((row) => [
          JSON.stringify([row.collection_id, row.id]),
          {
            id: row.id,
            version: row.version,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        ]),
      );
      for (const key of order) {
        if (key === null) results.push(null);
        else {
          const result = written.get(key);
          if (!result)
            throw new Error("Batch write did not return a document.");
          results.push(result);
        }
      }
    }
    // Document triggers maintain usage inside this transaction, including
    // repeated IDs and deletions. A quota failure rolls it all back together.
    const usage = await tx
      .selectFrom("users")
      .where("id", "=", owner.id)
      .select(["site_data_bytes_used", "site_data_document_count"])
      .executeTakeFirstOrThrow();
    if (
      Number(usage.site_data_bytes_used) > MAX_SITE_BYTES ||
      Number(usage.site_data_document_count) > MAX_DOCUMENTS
    )
      throw new DataError(
        409,
        "Site database quota exceeded.",
        "QUOTA_EXCEEDED",
      );
    // In operation order: a set's new revision and stamps, null for a delete.
    return { success: true, results };
  });
}
