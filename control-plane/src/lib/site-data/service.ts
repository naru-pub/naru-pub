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
import { filters } from "./filters";
import { sorting, decodeCursor, encodeCursor } from "./pagination";
import { tokenScope, limitPublicCreate } from "./owner-auth";

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
};

export async function executeData(command: DataCommand) {
  const { site, path, method, adminUserId, body = {} } = command;
  if (path.length > 2) throw new DataError(404, "Not found.");
  path.forEach(name);
  return db.transaction().execute(async (tx) => {
    // All operations lock the owner row. Rules, quota checks and document writes
    // are serialized across processes, including concurrent collection deletion.
    const owner = await tx
      .selectFrom("users")
      .select("id")
      .where("login_name", "=", site)
      .forUpdate()
      .executeTakeFirst();
    if (!owner) throw new DataError(404, "Site not found.");
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
      throw new DataError(403, "Collection is outside the approved scope.");
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
          .select(["id", "data", "created_at", "updated_at"])
          .executeTakeFirst();
        if (!document) throw new DataError(404, "Document not found.");
        return { document };
      }
      const limit = command.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new DataError(400, "Limit must be 1–100.");
      const { orderBy, direction } = sorting(
        command.orderBy,
        command.direction,
      );
      const filter = filters(command.where);
      const cursor = decodeCursor(
        command.after,
        collection.id,
        orderBy,
        direction,
        filter.fingerprint,
      );
      const comparison = direction === "asc" ? ">" : "<";
      let query = documents()
        .select(["id", "data", "created_at", "updated_at"])
        .select(
          (orderBy === "id"
            ? sql<string | null>`null`
            : sql<string>`to_char(${sql.ref(orderBy)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
          ).as("cursor_value"),
        )
        .orderBy(orderBy, direction)
        .limit(limit + 1);
      if (filter.entries.length) {
        // GIN finds candidates; equality checks enforce exact scalar semantics,
        // so arrays containing a scalar never count as a scalar field match.
        query = query.where(sql<boolean>`data @> ${filter.json}::jsonb`);
        for (const [field, value] of filter.entries) {
          query = query.where(
            sql<boolean>`data -> ${field} = ${JSON.stringify(value)}::jsonb`,
          );
        }
      }
      if (orderBy !== "id") query = query.orderBy("id", direction);
      if (cursor) {
        if (orderBy === "id") query = query.where("id", comparison, cursor.id);
        else
          query = query.where(
            sql<boolean>`(${sql.ref(orderBy)}, id) ${sql.raw(comparison)} (${cursor.value}::timestamptz, ${cursor.id})`,
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
                orderBy,
                direction,
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
    if (method === "DELETE" && path.length === 2) {
      await tx
        .deleteFrom("site_data_documents")
        .where("collection_id", "=", collection.id)
        .where("id", "=", path[1])
        .execute();
      return { success: true };
    }
    if (
      !(
        (method === "POST" && path.length === 1) ||
        (method === "PUT" && path.length === 2)
      )
    )
      throw new DataError(405, "Method not allowed.");
    if (!Object.hasOwn(body, "data"))
      throw new DataError(400, "data is required.");
    if (creating && !admin)
      await limitPublicCreate(tx, owner.id, command.clientIp);
    const id = path[1] ?? randomUUID();
    const encoded = JSON.stringify(body.data);
    const size = Buffer.byteLength(encoded);
    if (size > MAX_DOCUMENT_BYTES)
      throw new DataError(413, "Document exceeds 64 KiB.");
    const existing = await documents()
      .where("id", "=", id)
      .select("size_bytes")
      .executeTakeFirst();
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
    if (creating) {
      // Never overwrite a document, even in the event of an ID collision.
      const inserted = await insert
        .onConflict((oc) => oc.columns(["collection_id", "id"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!inserted)
        throw new DataError(409, "Document ID collision. Retry creation.");
    } else {
      await insert
        .onConflict((oc) =>
          oc.columns(["collection_id", "id"]).doUpdateSet({
            data: sql`${encoded}::jsonb`,
            size_bytes: size,
            updated_at: new Date(),
          }),
        )
        .execute();
    }
    // Do not read/return stored data: write-only callers may not read it.
    return { id };
  });
}
