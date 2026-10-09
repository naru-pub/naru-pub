import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { callSiteDataWorker } from "./durable-object";
import type { SiteDataState } from "./backend";
import type { Collection } from "./service";

// Moves one site's collections and documents between PostgreSQL and its
// Durable Object, ids, revisions and timestamps included, so sign-in grants
// (which name collection ids) and conditional writes carry across.
//
// While a site is `moving_*` it is read from where it came from and refuses
// writes: PostgreSQL checks the state under the owner row lock, which the move
// takes, and the object is frozen before it is copied. A move that fails
// anywhere puts the site back where it was.

/** A site's whole store, as both backends export it. Times are epoch ms. */
export type Snapshot = {
  ownerId: string | null;
  collections: Collection[];
  documents: {
    collection_id: string;
    id: string;
    /** JSON text. */
    data: string;
    size_bytes: number;
    version: number;
    created_at: number;
    updated_at: number;
  }[];
};

const INSERT_CHUNK = 500;
/** As JSON values: a snapshot from the Worker was parsed in another realm. */
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

export async function postgresSnapshot(userId: string): Promise<Snapshot> {
  const collections = await db
    .selectFrom("site_data_collections")
    .select(["id", "name", "read_access", "write_access"])
    .where("user_id", "=", userId)
    .orderBy("id")
    .execute();
  const documents = await db
    .selectFrom("site_data_documents as d")
    .innerJoin("site_data_collections as c", "c.id", "d.collection_id")
    .select([
      "d.collection_id",
      "d.id",
      "d.data",
      "d.size_bytes",
      "d.version",
      "d.created_at",
      "d.updated_at",
    ])
    .where("c.user_id", "=", userId)
    .orderBy("d.collection_id")
    .orderBy("d.id")
    .execute();
  return {
    // Text, as the object stores it, whatever type the id column has.
    ownerId: String(userId),
    // Ids as text too: the object stores them as text, and compares them.
    collections: collections.map((c) => ({ ...c, id: String(c.id) })),
    documents: documents.map((row) => ({
      collection_id: String(row.collection_id),
      id: row.id,
      data: JSON.stringify(row.data),
      size_bytes: row.size_bytes,
      version: row.version,
      created_at: new Date(row.created_at).getTime(),
      updated_at: new Date(row.updated_at).getTime(),
    })),
  };
}

/** Replaces the owner's PostgreSQL collections and documents with `snapshot`. */
async function restorePostgres(userId: string, snapshot: Snapshot) {
  await db.transaction().execute(async (tx) => {
    await tx
      .selectFrom("users")
      .select("id")
      .where("id", "=", userId)
      .forUpdate()
      .execute();
    // Cascades to documents; the usage triggers keep the counters right.
    await tx
      .deleteFrom("site_data_collections")
      .where("user_id", "=", userId)
      .execute();
    if (snapshot.collections.length)
      await tx
        .insertInto("site_data_collections")
        .values(snapshot.collections.map((c) => ({ ...c, user_id: userId })))
        .execute();
    for (let i = 0; i < snapshot.documents.length; i += INSERT_CHUNK)
      await tx
        .insertInto("site_data_documents")
        .values(
          snapshot.documents.slice(i, i + INSERT_CHUNK).map((d) => ({
            collection_id: d.collection_id,
            id: d.id,
            data: sql`${d.data}::jsonb`,
            size_bytes: d.size_bytes,
            version: d.version,
            created_at: new Date(d.created_at),
            updated_at: new Date(d.updated_at),
          })),
        )
        .execute();
  });
}

/**
 * The first way two snapshots differ, or null. Document data is compared as
 * JSON values: JSONB reorders object keys, which carry no meaning.
 */
export function snapshotDifference(a: Snapshot, b: Snapshot): string | null {
  if (a.ownerId !== b.ownerId)
    return `owner ${a.ownerId} is ${b.ownerId} in the copy`;
  const byId = <T extends { id: string }>(rows: T[]) =>
    [...rows].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const left = byId(a.collections);
  const right = byId(b.collections);
  if (left.length !== right.length)
    return `${left.length} collections, ${right.length} in the copy`;
  for (let i = 0; i < left.length; i += 1)
    if (!isDeepStrictEqual(json(left[i]), json(right[i])))
      return `collection ${left[i].name} differs in the copy`;
  const key = (d: Snapshot["documents"][number]) =>
    `${d.collection_id}/${d.id}`;
  const copied = new Map(b.documents.map((d) => [key(d), d]));
  if (a.documents.length !== b.documents.length)
    return `${a.documents.length} documents, ${b.documents.length} in the copy`;
  for (const document of a.documents) {
    const copy = copied.get(key(document));
    if (!copy) return `document ${key(document)} is missing from the copy`;
    for (const field of [
      "size_bytes",
      "version",
      "created_at",
      "updated_at",
    ] as const)
      if (document[field] !== copy[field])
        return `document ${key(document)} has ${field} ${document[field]}, ${copy[field]} in the copy`;
    if (!isDeepStrictEqual(JSON.parse(document.data), JSON.parse(copy.data)))
      return `document ${key(document)} has different data in the copy`;
  }
  return null;
}

type Direction = "durable_object" | "postgres";

/** Sets the state from `from` to `to`, refusing if it is not `from`. */
async function transition(
  site: string,
  from: SiteDataState,
  to: SiteDataState,
) {
  const owner = await db.transaction().execute(async (tx) => {
    // Waits for writes in flight: each holds this row's lock.
    const row = await tx
      .selectFrom("users")
      .select(["id", "site_data_backend"])
      .where("login_name", "=", site)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new Error(`No Naru site is named ${site}.`);
    if (row.site_data_backend !== from)
      throw new Error(`${site} is ${row.site_data_backend}, not ${from}.`);
    await tx
      .updateTable("users")
      .set({ site_data_backend: to })
      .where("id", "=", row.id)
      .execute();
    return row;
  });
  return owner.id;
}

export async function moveSite(
  site: string,
  to: Direction,
  log: (message: string) => void = () => {},
) {
  if (to === "durable_object") {
    const ownerId = await transition(
      site,
      "postgres",
      "moving_to_durable_object",
    );
    try {
      const snapshot = await postgresSnapshot(ownerId);
      log(
        `Copying ${snapshot.collections.length} collections and ${snapshot.documents.length} documents`,
      );
      await callSiteDataWorker(site, "import", snapshot);
      const copy = await callSiteDataWorker<Snapshot>(site, "export", {});
      const difference = snapshotDifference(snapshot, copy);
      if (difference) throw new Error(`Copy does not match: ${difference}`);
      await transition(site, "moving_to_durable_object", "durable_object");
    } catch (error) {
      // Nothing routes to the object until the state says so, so its partial
      // copy is harmless; the next move replaces it.
      await transition(site, "moving_to_durable_object", "postgres");
      throw error;
    }
    return;
  }
  const ownerId = await transition(
    site,
    "durable_object",
    "moving_to_postgres",
  );
  try {
    // The object runs one request at a time: once this returns, no write is
    // in flight and none will be accepted.
    await callSiteDataWorker(site, "freeze", {});
    const snapshot = await callSiteDataWorker<Snapshot>(site, "export", {});
    if (snapshot.ownerId !== null && snapshot.ownerId !== String(ownerId))
      throw new Error(`${site}'s object belongs to ${snapshot.ownerId}.`);
    log(
      `Copying ${snapshot.collections.length} collections and ${snapshot.documents.length} documents`,
    );
    const expected = { ...snapshot, ownerId: String(ownerId) };
    await restorePostgres(ownerId, expected);
    const copy = await postgresSnapshot(ownerId);
    const difference = snapshotDifference(expected, copy);
    if (difference) throw new Error(`Copy does not match: ${difference}`);
    // The object stays frozen: a request that resolved to it a moment ago
    // can still read, but never write, and the copy is kept until a later
    // move replaces it or the account is deleted.
    await transition(site, "moving_to_postgres", "postgres");
  } catch (error) {
    await callSiteDataWorker(site, "unfreeze", {});
    await transition(site, "moving_to_postgres", "durable_object");
    throw error;
  }
}
