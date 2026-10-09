import { db, requestDeadline } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { tokenScope } from "./owner-auth";
import {
  executeBatch,
  executeData,
  noSite,
  type Collection,
  type CollectionSettings,
  type DataCommand,
} from "./service";
import { DataError, name, type ErrorCode } from "./validation";

// The Durable Objects backend: one object per site in the site-data-worker
// (repository root). Sign-in, paid status and media stay in PostgreSQL, so
// every request is admitted here first and the object is told the outcome.
// The Worker is reached over HTTPS with a shared secret; it has no other
// callers.

const WORKER_TIMEOUT_MS = 10_000;

const unavailable = () =>
  new DataError(
    503,
    "The site database is unavailable. Try again shortly.",
    "UNAVAILABLE",
  );

export function siteDataWorkerConfigured() {
  return Boolean(
    process.env.SITE_DATA_WORKER_URL && process.env.SITE_DATA_WORKER_SECRET,
  );
}

/**
 * Calls one operation on a site's object. A refusal the object made arrives
 * as the DataError it threw; anything else the Worker answers is logged and
 * reported as unavailable.
 */
export async function callSiteDataWorker<T>(
  site: string,
  operation: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const base = process.env.SITE_DATA_WORKER_URL;
  const secret = process.env.SITE_DATA_WORKER_SECRET;
  if (!base || !secret) {
    console.error("SITE_DATA_WORKER_URL or SITE_DATA_WORKER_SECRET is unset");
    throw unavailable();
  }
  const timeout = AbortSignal.timeout(WORKER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(
      new URL(`/v1/sites/${encodeURIComponent(site)}/${operation}`, base),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );
  } catch (error) {
    // The caller canceled: http.ts reports that itself.
    if (signal?.aborted) throw error;
    console.error("Site database Worker unreachable", error);
    throw unavailable();
  }
  const body = (await response.json().catch(() => null)) as {
    value?: T;
    error?: { status: number; message: string; code?: ErrorCode };
  } | null;
  if (response.ok && body && "value" in body) return body.value as T;
  if (body?.error && body.error.status === response.status)
    throw new DataError(body.error.status, body.error.message, body.error.code);
  console.error(
    `Site database Worker answered ${response.status} to ${operation}`,
  );
  throw unavailable();
}

/** The object reports times as ISO strings; PostgreSQL's backend as Dates. */
function withDates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withDates);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "data"
        ? item
        : (key === "createdAt" || key === "updatedAt") &&
            typeof item === "string"
          ? new Date(item)
          : withDates(item),
    ]),
  );
}

/**
 * What PostgreSQL decides about a request: the owner, whether the site has
 * the database feature, and the sign-in's scope (renewing its token). The
 * same checks, in the same order, as service.ts.
 */
async function admit(command: DataCommand) {
  return db.transaction().execute(async (tx) => {
    await requestDeadline(tx);
    const owner = await tx
      .selectFrom("users")
      .select(["id", "site_data_backend"])
      .where("login_name", "=", command.site)
      .executeTakeFirst();
    if (!owner) throw noSite(command.site);
    if (!(await userHasFeature(owner.id, "database", tx)))
      throw new DataError(403, "Database access is not enabled for this site.");
    const allowedIds = command.bearer
      ? await tokenScope(tx, owner.id, command.bearer)
      : undefined;
    return { owner, allowedIds };
  });
}

/** A request that resolved here just as its site moved back to PostgreSQL. */
const onPostgres = (state: string) =>
  state === "postgres" || state === "moving_to_durable_object";

export async function executeOnDurableObject(command: DataCommand) {
  const { path, adminUserId } = command;
  if (path.length > 2) throw new DataError(404, "Not found.");
  path.forEach(name);
  const { owner, allowedIds } = await admit(command);
  if (onPostgres(owner.site_data_backend)) return executeData(command);
  const admin = adminUserId === owner.id || allowedIds !== undefined;
  if (adminUserId !== undefined && !admin)
    throw new DataError(403, "Permission denied.");
  const { result, publicRead } = await callSiteDataWorker<{
    result: unknown;
    publicRead: boolean;
  }>(
    command.site,
    "execute",
    {
      ownerId: String(owner.id),
      access: {
        admin,
        allowedIds: allowedIds?.map(String) ?? null,
        anonymous: command.bearer === undefined && adminUserId === undefined,
      },
      path,
      method: command.method,
      body: command.body,
      filter: command.filter,
      size: command.size,
      sort: command.sort,
      after: command.after,
      includeTotal: command.includeTotal,
      ifVersion: command.ifVersion,
      clientIp: command.clientIp,
    },
    command.signal,
  );
  if (publicRead && command.cacheability) command.cacheability.public = true;
  return withDates(result);
}

export async function batchOnDurableObject(command: DataCommand) {
  if (command.method !== "POST")
    throw new DataError(405, "Method not allowed.");
  const operations = command.body?.operations;
  if (
    !Array.isArray(operations) ||
    !operations.length ||
    operations.length > 100
  )
    throw new DataError(400, "Batch requires 1–100 operations.");
  const { owner, allowedIds } = await admit(command);
  if (onPostgres(owner.site_data_backend)) return executeBatch(command);
  if (allowedIds === undefined && command.adminUserId !== owner.id)
    throw new DataError(403, "A batch needs an owner sign-in.");
  return withDates(
    await callSiteDataWorker(
      command.site,
      "batch",
      {
        ownerId: String(owner.id),
        allowedIds: allowedIds?.map(String) ?? null,
        operations,
      },
      command.signal,
    ),
  );
}

export function collectionsOnDurableObject(site: string, names?: string[]) {
  if (names?.length === 0) return Promise.resolve([]);
  return callSiteDataWorker<Collection[]>(site, "collections", { names });
}

export function createCollectionsOnDurableObject(
  owner: { id: string; loginName: string },
  collections: CollectionSettings[],
) {
  if (!collections.length) return Promise.resolve([]);
  return callSiteDataWorker<string[] | null>(
    owner.loginName,
    "createCollections",
    { ownerId: String(owner.id), collections },
  );
}

/**
 * Erases a deleted account's object, whichever store the site was on: one
 * that moved back to PostgreSQL keeps its frozen copy until now.
 */
export async function eraseSiteData(site: string) {
  if (!siteDataWorkerConfigured()) return;
  await callSiteDataWorker(site, "erase", {});
}
