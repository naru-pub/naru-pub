import { db } from "@/lib/database";
import type { Executor } from "@/lib/entitlements";
import type { Users } from "@/lib/db";
import type { Selectable } from "kysely";
import {
  createCollections,
  executeBatch,
  executeData,
  listCollections,
  type Collection,
  type CollectionSettings,
  type DataCommand,
} from "./service";
import {
  batchOnDurableObject,
  collectionsOnDurableObject,
  createCollectionsOnDurableObject,
  executeOnDurableObject,
} from "./durable-object";

export type { Collection, CollectionSettings };

/** The account a site belongs to: its id, and its name, which is the site's. */
export type SiteOwner = { id: string; loginName: string };

export type SiteDataState = Selectable<Users>["site_data_backend"];

/**
 * Where a site's collections and documents are stored. Everything outside
 * lib/site-data reaches them through this, so a site can move to another store
 * without its callers changing. Sign-in, paid status and media stay in
 * PostgreSQL whichever backend holds the documents.
 */
export interface SiteDataBackend {
  /** A collection or document request, from the v1 route or the control panel. */
  execute(command: DataCommand): Promise<unknown>;
  /** A `_batch` of sets and deletes, applied together or not at all. */
  batch(command: DataCommand): Promise<unknown>;
  /**
   * The site's collections named in `names`, or all of them, by name.
   * PostgreSQL reads through `executor`, the caller's transaction if any.
   */
  collections(
    owner: SiteOwner,
    names?: string[],
    executor?: Executor,
  ): Promise<Collection[]>;
  /**
   * Creates the missing collections empty, or none when they would exceed the
   * collection limit (null). PostgreSQL joins `executor` when it is the
   * caller's transaction; another backend commits on its own.
   */
  createCollections(
    owner: SiteOwner,
    collections: CollectionSettings[],
    executor?: Executor,
  ): Promise<string[] | null>;
}

// Arrow functions, not the imports themselves: owner-auth reaches this module
// through a cycle, and the imports are bound only once every module has run.
const postgres: SiteDataBackend = {
  execute: (command) => executeData(command),
  batch: (command) => executeBatch(command),
  collections: (owner, names, executor) =>
    listCollections(owner.id, names, executor),
  createCollections: (owner, collections, executor) =>
    createCollections(owner.id, collections, executor),
};

const durableObject: SiteDataBackend = {
  execute: (command) => executeOnDurableObject(command),
  batch: (command) => batchOnDurableObject(command),
  collections: (owner, names) =>
    collectionsOnDurableObject(owner.loginName, names),
  createCollections: (owner, collections) =>
    createCollectionsOnDurableObject(owner, collections),
};

/**
 * The store a site is read from in each state. A moving site is read from
 * where it came from; both backends refuse its writes until the move ends.
 */
export function backendIn(state: SiteDataState): SiteDataBackend {
  return state === "durable_object" || state === "moving_to_postgres"
    ? durableObject
    : postgres;
}

/** The backend serving `site`, read through `executor` when given. */
export async function siteDataBackend(
  site: string,
  executor: Executor = db,
): Promise<SiteDataBackend> {
  const row = await executor
    .selectFrom("users")
    .select("site_data_backend")
    .where("login_name", "=", site)
    .executeTakeFirst();
  // An unknown site gets PostgreSQL, whose service reports it missing.
  return backendIn(row?.site_data_backend ?? "postgres");
}
