import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { db } from "@/lib/database";
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
import { sorting, decodeCursor, encodeCursor } from "./pagination";
import { tokenScope, limitPublicCreate } from "./owner-auth";
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
  after?: string;
  limit?: number;
  orderBy?: string;
  direction?: string;
  where?: unknown;
  count?: boolean;
  ifVersion?: number;
};

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
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Shallow merge: patch fields replace stored fields, `unset` names removed. */
function merge(
  existing: { data: unknown } | undefined,
  body: Record<string, unknown>,
) {
  if (!existing) throw new DataError(404, "Document not found.");
  if (!isObject(body.data))
    throw new DataError(400, "A merge patch must be a JSON object.");
  if (!isObject(existing.data))
    throw new DataError(
      409,
      "Only object documents can be merged.",
      "NOT_MERGEABLE",
    );
  const unset = body.unset ?? [];
  if (!Array.isArray(unset) || unset.some((key) => typeof key !== "string"))
    throw new DataError(400, "unset must be an array of field names.");
  const merged: Record<string, unknown> = { ...existing.data, ...body.data };
  // Removal is explicit: a null in the patch stores null rather than deleting.
  for (const key of unset) delete merged[key as string];
  return merged;
}

function filterConditions(filter: ReturnType<typeof filters>) {
  const conditions = [];
  if (filter.entries.length) {
    // GIN finds candidates; equality checks enforce exact scalar semantics,
    // so arrays containing a scalar never count as a scalar field match.
    conditions.push(sql<boolean>`data @> ${filter.json}::jsonb`);
    for (const [field, value] of filter.entries)
      conditions.push(
        sql<boolean>`data -> ${field} = ${JSON.stringify(value)}::jsonb`,
      );
  }
  for (const [field, operator, bound] of filter.ranges) {
    // JSONB orders numbers above strings, so ranges compare within one type
    // only. Comparing JSONB rather than a cast never raises on other types.
    conditions.push(
      sql<boolean>`jsonb_typeof(data -> ${field}) = ${typeof bound} and data -> ${field} ${sql.raw(
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
  return db.transaction().execute(async (tx) => {
    // All operations lock the owner row. Rules, quota checks and document writes
    // are serialized across processes, including concurrent collection deletion.
    const owner = await tx
      .selectFrom("users")
      .select(["id", "supporter_comp"])
      .where("login_name", "=", site)
      .forUpdate()
      .executeTakeFirst();
    if (!owner) throw new DataError(404, "Site not found.");
    const preview = previewFeatureAccess(!!owner.supporter_comp, "database");
    if (!(preview ?? (await userHasFeature(owner.id, "database"))))
      throw new DataError(403, "Database access is not enabled for this site.");
    // Reads happen on every visitor pageview of a site that uses the SDK; a
    // write is the owner's own data actually living in 나루.
    if (command.method !== "GET") noteSupporterFeatureUse(owner.id, "database");
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
      if (path.length === 2) {
        const document = await documents()
          .where("id", "=", path[1])
          .select(["id", "data", "created_at", "updated_at", "version"])
          .executeTakeFirst();
        if (!document) throw new DataError(404, "Document not found.");
        return { document };
      }
      const filter = filters(command.where);
      const conditions = filterConditions(filter);
      if (command.count) {
        let counter = documents().select(
          tx.fn.countAll<string>().as("matched"),
        );
        for (const condition of conditions) counter = counter.where(condition);
        return {
          count: Number((await counter.executeTakeFirstOrThrow()).matched),
        };
      }
      const limit = command.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new DataError(400, "Limit must be 1–100.");
      const sort = sorting(command.orderBy, command.direction);
      const cursor = decodeCursor(
        command.after,
        collection.id,
        sort,
        filter.fingerprint,
      );
      const comparison = sort.direction === "asc" ? ">" : "<";
      // A missing field collapses to JSON null, the lowest JSONB value, so the
      // sort key is never SQL NULL and the tuple comparison stays a total order.
      const sortValue = sort.field
        ? sql`coalesce(data -> ${sort.field}, 'null'::jsonb)`
        : sql.ref(sort.orderBy);
      let query = documents()
        .select(["id", "data", "created_at", "updated_at", "version"])
        .select(
          (sort.orderBy === "id"
            ? sql<string | null>`null`
            : sort.field
              ? sql<string>`(${sortValue})::text`
              : sql<string>`to_char(${sortValue} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
          ).as("cursor_value"),
        )
        .orderBy(sortValue, sort.direction)
        .limit(limit + 1);
      for (const condition of conditions) query = query.where(condition);
      if (sort.orderBy !== "id") query = query.orderBy("id", sort.direction);
      if (cursor) {
        if (sort.orderBy === "id")
          query = query.where("id", comparison, cursor.id);
        else
          query = query.where(
            sql<boolean>`(${sortValue}, id) ${sql.raw(comparison)} (${
              sort.field
                ? sql`${cursor.value}::jsonb`
                : sql`${cursor.value}::timestamptz`
            }, ${cursor.id})`,
          );
      }
      const rows = await query.execute();
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        documents: page.map(({ cursor_value: _, ...document }) => document),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor(
                collection.id,
                sort,
                last.id,
                last.cursor_value,
                filter.fingerprint,
              )
            : null,
      };
    }
    const creating = method === "POST" && path.length === 1;
    if (!(creating && collection.write_access === "create"))
      authorize(collection.write_access, admin);
    const expected = expectedVersion(command.ifVersion);
    const current = (id: string) =>
      documents()
        .where("id", "=", id)
        .select(["size_bytes", "data", "version"])
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
    const patching = method === "PATCH" && path.length === 2;
    if (!(creating || (method === "PUT" && path.length === 2) || patching))
      throw new DataError(405, "Method not allowed.");
    if (!Object.hasOwn(body, "data"))
      throw new DataError(400, "data is required.");
    if (creating && !admin)
      await limitPublicCreate(tx, owner.id, command.clientIp);
    const id = path[1] ?? randomUUID();
    const existing = await current(id);
    if (expected !== undefined) matchVersion(expected, existing?.version);
    const data = patching ? merge(existing, body) : body.data;
    const encoded = JSON.stringify(data);
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
    let version = 1;
    if (creating) {
      // Never overwrite a document, even in the event of an ID collision.
      const inserted = await insert
        .onConflict((oc) => oc.columns(["collection_id", "id"]).doNothing())
        .returning("version")
        .executeTakeFirst();
      if (!inserted)
        throw new DataError(409, "Document ID collision. Retry creation.");
      version = inserted.version;
    } else {
      version = (
        await insert
          .onConflict((oc) =>
            oc.columns(["collection_id", "id"]).doUpdateSet({
              data: sql`${encoded}::jsonb`,
              size_bytes: size,
              updated_at: new Date(),
              // Every accepted write advances the version conditional writes quote.
              version: sql`site_data_documents.version + 1`,
            }),
          )
          .returning("version")
          .executeTakeFirstOrThrow()
      ).version;
    }
    // Do not read/return stored data: write-only callers may not read it.
    // The version is write metadata, not content, and conditional writes need it.
    return { id, version };
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
    const owner = await tx
      .selectFrom("users")
      .select(["id", "supporter_comp"])
      .where("login_name", "=", command.site)
      .forUpdate()
      .executeTakeFirst();
    if (!owner) throw new DataError(404, "Site not found.");
    const preview = previewFeatureAccess(!!owner.supporter_comp, "database");
    if (!(preview ?? (await userHasFeature(owner.id, "database"))))
      throw new DataError(403, "Database access is not enabled for this site.");
    // Reads happen on every visitor pageview of a site that uses the SDK; a
    // write is the owner's own data actually living in 나루.
    if (command.method !== "GET") noteSupporterFeatureUse(owner.id, "database");
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
    const collectionRows = await tx
      .selectFrom("site_data_collections")
      .selectAll()
      .where("user_id", "=", owner.id)
      .execute();
    const results: { id?: string; version?: number; success?: true }[] = [];
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
      const merging = operation.type === "update";
      // The batch holds the owner lock, so a read here cannot go stale before
      // the write that follows it.
      const existing =
        expected !== undefined || merging
          ? await tx
              .selectFrom("site_data_documents")
              .where("collection_id", "=", collection.id)
              .where("id", "=", id)
              .select(["data", "version"])
              .executeTakeFirst()
          : undefined;
      if (expected !== undefined) matchVersion(expected, existing?.version);
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
        !(operation.type === "set" || merging || adding) ||
        !Object.hasOwn(operation, "data")
      )
        throw new DataError(
          400,
          "Batch operations must be add, set, update or delete.",
        );
      const encoded = JSON.stringify(
        merging ? merge(existing, operation) : operation.data,
      );
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
          .returning("version")
          .executeTakeFirst();
        if (!inserted)
          throw new DataError(409, "Document ID collision. Retry creation.");
        results.push({ id, version: inserted.version });
        continue;
      }
      const written = await insert
        .onConflict((oc) =>
          oc.columns(["collection_id", "id"]).doUpdateSet({
            data: sql`${encoded}::jsonb`,
            size_bytes: size,
            updated_at: new Date(),
            version: sql`site_data_documents.version + 1`,
          }),
        )
        .returning("version")
        .executeTakeFirstOrThrow();
      results.push({ id, version: written.version });
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
