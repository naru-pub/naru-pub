import { randomUUID } from "node:crypto";
import { sql } from "kysely";
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
import { tokenScope, limitPublicWrite } from "./owner-auth";
import { previewFeatureAccess, userHasFeature } from "@/lib/entitlements";
import { noteSupporterFeatureUse } from "@/lib/feature-usage";

export type DataCommand = {
  site: string;
  path: string[];
  method: string;
  adminUserId?: number;
  bearer?: { token: string; origin: string | null };
  clientIp?: string;
  body?: Record<string, unknown>;
  pageToken?: string;
  limit?: number;
  /** JSON array of one or two [field, direction] pairs. */
  orderBy?: string;
  where?: unknown;
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
/** Every accepted write reports the version and stamps conditional writes and
 * optimistic rendering both need, so a caller never has to guess a timestamp. */
const WRITTEN = ["version", "created_at", "updated_at"] as const;
const written = (
  id: string,
  row: { version: number; created_at: Date; updated_at: Date },
) => ({
  id,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** `0` asserts the document does not exist yet, so a create cannot clobber. */
function expectedVersion(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new DataError(400, "ifVersion must be a non-negative integer.");
  return value;
}
function matchVersion(expected: number, actual: number | undefined) {
  if (expected !== (actual ?? 0))
    throw new DataError(
      409,
      "Document version does not match ifVersion.",
      "VERSION_CONFLICT",
    );
}
/** Documents filter on `data`; media filters on `metadata`. The column is only
 * ever one of those two literals, never caller-supplied text. */
export function filterConditions(
  filter: ReturnType<typeof filters>,
  column: "data" | "metadata" = "data",
) {
  const target = sql.ref(column);
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
    conditions.push(
      sql<boolean>`jsonb_typeof(${target} -> ${field}) = ${typeof bound} and ${target} -> ${field} ${sql.raw(
        COMPARISONS[operator],
      )} ${JSON.stringify(bound)}::jsonb`,
    );
  }
  return conditions;
}

export async function executeData(command: DataCommand) {
  const { site, path, method, adminUserId, body = {} } = command;
  if (path.length > 2) throw new DataError(404, "Not found.");
  path.forEach(name);
  const reading = method === "GET";
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
      .select(["id", "supporter_comp"])
      .where("login_name", "=", site);
    const owner = await (
      reading ? ownerQuery : ownerQuery.forUpdate()
    ).executeTakeFirst();
    if (!owner) throw new DataError(404, "Site not found.");
    const preview = previewFeatureAccess(!!owner.supporter_comp, "database");
    // `tx`, never the pool: this runs inside the transaction, and taking a
    // second connection while holding the first is how the pool deadlocks.
    if (!(preview ?? (await userHasFeature(owner.id, "database", tx))))
      throw new DataError(403, "Database access is not enabled for this site.");
    // Only once the request is authorized. A stranger's refused write is not
    // the owner getting value out of a 후원자 전용 기능, and recording it here
    // would let anyone drive ledger queries with requests that end in 403.
    let recorded = false;
    const noteUse = () => {
      if (recorded || reading) return;
      recorded = true;
      noteSupporterFeatureUse(owner.id, "database");
    };
    const allowedIds = command.bearer
      ? await tokenScope(
          tx,
          owner.id,
          command.bearer.token,
          command.bearer.origin,
        )
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
      noteUse();
      const collectionName = name(body.name);
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
        throw new DataError(409, "Collection limit reached.");
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
    if (!collection) throw new DataError(404, "Collection not found.");
    if (allowedIds !== undefined && !allowedIds.includes(collection.id))
      throw new DataError(
        403,
        "Collection is outside the approved scope.",
        "COLLECTION_NOT_AUTHORIZED",
      );
    if (path.length === 1 && (method === "PATCH" || method === "DELETE")) {
      if (allowedIds !== undefined)
        throw new DataError(403, "Website tokens cannot manage collections.");
      if (!admin) throw new DataError(403, "Admin access required.");
      noteUse();
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
      authorize(collection.read_access, admin);
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
      const filter = filters(command.where);
      const conditions = filterConditions(filter);
      const limit = command.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new DataError(400, "Limit must be 1–100.");
      const sorts = sortings(command.orderBy);
      const sort = sorts[0];
      const multiple = sorts.length > 1;
      const cursor = multiple
        ? decodeMultiCursor(
            command.pageToken,
            collection.id,
            sorts,
            filter.fingerprint,
          )
        : decodeCursor(
            command.pageToken,
            collection.id,
            sort,
            filter.fingerprint,
          );
      // A missing field collapses to JSON null, the lowest JSONB value, so the
      // sort key is never SQL NULL and the tuple comparison stays a total order.
      const sortValues = sorts.map((item) =>
        item.field
          ? sql`coalesce(data -> ${item.field}, 'null'::jsonb)`
          : sql.ref(item.column),
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
              ? sql<string>`(${value})::text`
              : sql<string>`to_char(${value} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
          ).as(`cursor_value_${index}`),
        );
        query = query.orderBy(value, item.direction);
      }
      query = query.limit(limit + 1);
      for (const condition of conditions) query = query.where(condition);
      if (!sorts.some((item) => item.orderBy === "id"))
        query = query.orderBy("id", sorts.at(-1)!.direction);
      if (cursor) {
        if (!multiple) {
          const single = cursor as { id: string; value: string | null };
          const comparison = sort.direction === "asc" ? ">" : "<";
          if (sort.orderBy === "id")
            query = query.where("id", comparison, single.id);
          else
            query = query.where(
              sql<boolean>`(${sortValue}, id) ${sql.raw(comparison)} (${
                sort.field
                  ? sql`${single.value}::jsonb`
                  : sql`${single.value}::timestamptz`
              }, ${single.id})`,
            );
        } else {
          const multi = cursor as { id: string; values: string[] };
          const cursorValues = sorts.map((item, index) =>
            item.field
              ? sql`${multi.values[index]}::jsonb`
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
                sql<boolean>`id ${sql.raw(idComparison)} ${multi.id}`,
              ],
              sql` and `,
            )})`,
          );
          query = query.where(sql<boolean>`(${sql.join(branches, sql` or `)})`);
        }
      }
      const rows = (await query.execute()) as Array<{
        id: string;
        data: unknown;
        version: number;
        createdAt: Date;
        updatedAt: Date;
        cursor_value_0?: string | null;
        cursor_value_1?: string | null;
      }>;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      let total: number | undefined;
      if (command.includeTotal) {
        let counter = documents().select(
          tx.fn.countAll<string>().as("matched"),
        );
        for (const condition of conditions) counter = counter.where(condition);
        total = Number((await counter.executeTakeFirstOrThrow()).matched);
      }
      return {
        documents: page.map((row) => {
          const document = { ...row };
          delete document.cursor_value_0;
          delete document.cursor_value_1;
          return document;
        }),
        nextPageToken:
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
        total,
      };
    }
    const creating = method === "POST" && path.length === 1;
    if (!(creating && collection.write_access === "create"))
      authorize(collection.write_access, admin);
    noteUse();
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
    const usage = await tx
      .selectFrom("site_data_documents as d")
      .innerJoin("site_data_collections as c", "c.id", "d.collection_id")
      .where("c.user_id", "=", owner.id)
      .select([
        sql<number>`coalesce(sum(d.size_bytes), 0)`.as("bytes"),
        sql<number>`count(*)`.as("count"),
      ])
      .executeTakeFirstOrThrow();
    if (
      Number(usage.bytes) - (existing?.size_bytes ?? 0) + size >
        MAX_SITE_BYTES ||
      (!existing && Number(usage.count) >= MAX_DOCUMENTS)
    ) {
      throw new DataError(409, "Site database quota exceeded.");
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
    // Do not read/return stored data: write-only callers may not read it.
    // Version and timestamps are write metadata, not content. Spelled out here
    // rather than built by a helper so the union of results stays discriminable.
    return {
      id,
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
  return db.transaction().execute(async (tx) => {
    await requestDeadline(tx);
    // A batch is always a write, so it always takes the owner lock.
    const owner = await tx
      .selectFrom("users")
      .select(["id", "supporter_comp"])
      .where("login_name", "=", command.site)
      .forUpdate()
      .executeTakeFirst();
    if (!owner) throw new DataError(404, "Site not found.");
    const preview = previewFeatureAccess(!!owner.supporter_comp, "database");
    // `tx`, never the pool: a second connection taken while this one is held
    // is what empties the pool under concurrency.
    if (!(preview ?? (await userHasFeature(owner.id, "database", tx))))
      throw new DataError(403, "Database access is not enabled for this site.");
    const allowedIds = command.bearer
      ? await tokenScope(
          tx,
          owner.id,
          command.bearer.token,
          command.bearer.origin,
        )
      : undefined;
    if (allowedIds === undefined && command.adminUserId !== owner.id)
      throw new DataError(403, "Owner access required.");
    // Authorized, so this is the owner's own data being written.
    noteSupporterFeatureUse(owner.id, "database");
    const collectionRows = await tx
      .selectFrom("site_data_collections")
      .selectAll()
      .where("user_id", "=", owner.id)
      .execute();
    const results: {
      id?: string;
      version?: number;
      createdAt?: Date;
      updatedAt?: Date;
      success?: true;
    }[] = [];
    for (const raw of operations) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new DataError(400, "Invalid batch operation.");
      const operation = raw as Record<string, unknown>;
      const collectionName = name(operation.collection);
      const adding = operation.type === "add";
      if (adding && Object.hasOwn(operation, "id"))
        throw new DataError(400, "add assigns the document ID itself.");
      const id = adding ? randomUUID() : name(operation.id);
      const collection = collectionRows.find(
        (row) => row.name === collectionName,
      );
      if (!collection)
        throw new DataError(404, `Collection ${collectionName} not found.`);
      if (allowedIds !== undefined && !allowedIds.includes(collection.id))
        throw new DataError(
          403,
          `Collection ${collectionName} is outside the approved scope.`,
          "COLLECTION_NOT_AUTHORIZED",
        );
      authorize(collection.write_access, true);
      const expected = expectedVersion(operation.ifVersion);
      // A fresh ID has no version to quote, so the two cannot be combined.
      if (adding && expected !== undefined)
        throw new DataError(400, "add cannot take ifVersion.");
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
        await tx
          .deleteFrom("site_data_documents")
          .where("collection_id", "=", collection.id)
          .where("id", "=", id)
          .execute();
        results.push({ success: true });
        continue;
      }
      if (
        !(operation.type === "set" || adding) ||
        !Object.hasOwn(operation, "data")
      )
        throw new DataError(
          400,
          "Batch operations must be add, set or delete.",
        );
      const encoded = JSON.stringify(operation.data);
      const size = Buffer.byteLength(encoded);
      if (size > MAX_DOCUMENT_BYTES)
        throw new DataError(413, "Document exceeds 64 KiB.");
      const insert = tx.insertInto("site_data_documents").values({
        collection_id: collection.id,
        id,
        data: sql`${encoded}::jsonb`,
        size_bytes: size,
      });
      if (adding) {
        // Never overwrite a document, even in the event of an ID collision.
        const inserted = await insert
          .onConflict((oc) => oc.columns(["collection_id", "id"]).doNothing())
          .returning(WRITTEN)
          .executeTakeFirst();
        if (!inserted)
          throw new DataError(409, "Document ID collision. Retry creation.");
        results.push(written(id, inserted));
        continue;
      }
      const row = await insert
        .onConflict((oc) =>
          oc.columns(["collection_id", "id"]).doUpdateSet({
            data: sql`${encoded}::jsonb`,
            size_bytes: size,
            updated_at: new Date(),
            version: sql`site_data_documents.version + 1`,
          }),
        )
        .returning(WRITTEN)
        .executeTakeFirstOrThrow();
      results.push(written(id, row));
    }
    const usage = await tx
      .selectFrom("site_data_documents as d")
      .innerJoin("site_data_collections as c", "c.id", "d.collection_id")
      .where("c.user_id", "=", owner.id)
      .select([
        sql<number>`coalesce(sum(d.size_bytes), 0)`.as("bytes"),
        sql<number>`count(*)`.as("count"),
      ])
      .executeTakeFirstOrThrow();
    if (
      Number(usage.bytes) > MAX_SITE_BYTES ||
      Number(usage.count) > MAX_DOCUMENTS
    )
      throw new DataError(409, "Site database quota exceeded.");
    return { results };
  });
}
