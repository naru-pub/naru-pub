import { isDeepStrictEqual } from "node:util";
import { db } from "@/lib/database";
import { callSiteDataWorker } from "./durable-object";
import { postgresSnapshot } from "./move";
import { executeData } from "./service";
import { DataError, NAME } from "./validation";

// Runs the same reads against a site's PostgreSQL data and a scratch Durable
// Object copy of it, `compare:<site>`, and reports every query whose pages
// differ. Sorting and filtering are where the two stores could disagree (type
// ranking, byte-order strings, numeric comparison, cursors), so the queries
// sort and filter by the fields the site's documents actually have, and read
// in small pages to walk the cursors. The site itself is not touched.

type Query = { sort?: string; filter?: unknown; includeTotal?: boolean };
type Page = {
  documents: {
    id: string;
    data: unknown;
    version: number;
    createdAt: Date | string;
    updatedAt: Date | string;
  }[];
  nextCursor: string | null;
  totalCount?: number;
};

const PAGE_SIZE = 7;
const MAX_PAGES = 2000;
const MAX_FIELDS = 6;

const iso = (value: Date | string) => new Date(value).toISOString();
/** As JSON values: the Worker's answers are parsed in another realm. */
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** The fields most documents have, and a scalar value seen in each. */
function sampleFields(documents: unknown[]) {
  const seen = new Map<string, { count: number; value: unknown }>();
  for (const data of documents) {
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    for (const [field, value] of Object.entries(data)) {
      if (!NAME.test(field)) continue;
      const entry = seen.get(field) ?? { count: 0, value: undefined };
      entry.count += 1;
      const scalar =
        value === null ||
        ["string", "number", "boolean"].includes(typeof value);
      if (entry.value === undefined && scalar) entry.value = value;
      seen.set(field, entry);
    }
  }
  return [...seen.entries()]
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, MAX_FIELDS);
}

export function comparisonQueries(documents: unknown[]): Query[] {
  const createdAt = { metadata: "createdAt" };
  const queries: Query[] = [
    {},
    { sort: JSON.stringify([[createdAt, "desc"]]) },
    { sort: JSON.stringify([[{ metadata: "updatedAt" }, "asc"]]) },
  ];
  for (const [field, { value }] of sampleFields(documents)) {
    queries.push(
      { sort: JSON.stringify([[field, "asc"]]) },
      { sort: JSON.stringify([[field, "desc"]]) },
      {
        sort: JSON.stringify([
          [field, "asc"],
          [createdAt, "desc"],
        ]),
      },
      { filter: { [field]: null }, includeTotal: true },
    );
    if (value === undefined) continue;
    queries.push({ filter: { [field]: value }, includeTotal: true });
    if (typeof value === "string" || typeof value === "number")
      queries.push(
        {
          filter: { [field]: { gte: value } },
          sort: JSON.stringify([[field, "asc"]]),
          includeTotal: true,
        },
        {
          filter: { [field]: { lt: value } },
          sort: JSON.stringify([[field, "desc"]]),
        },
      );
  }
  return queries;
}

/** Every page of a query, or the refusal it ended with. */
async function readAll(read: (after?: string) => Promise<Page>) {
  const pages: unknown[] = [];
  let after: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await read(after);
      pages.push({
        documents: result.documents.map((document) => ({
          id: document.id,
          data: document.data,
          version: document.version,
          createdAt: iso(document.createdAt),
          updatedAt: iso(document.updatedAt),
        })),
        totalCount: result.totalCount,
      });
      if (!result.nextCursor) break;
      after = result.nextCursor;
    }
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
    pages.push({ refused: error.status, message: error.message });
  }
  return json(pages) as unknown[];
}

/** Where two results first part ways, briefly, for whoever reads the report. */
function firstDifference(expected: unknown[], actual: unknown[]) {
  const flat = (pages: unknown[]) =>
    pages.flatMap((page) =>
      "documents" in (page as object)
        ? [
            ...(page as { documents: unknown[] }).documents,
            { totalCount: (page as { totalCount?: number }).totalCount },
          ]
        : [page],
    );
  const left = flat(expected);
  const right = flat(actual);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1)
    if (!isDeepStrictEqual(left[i], right[i]))
      return `PostgreSQL ${JSON.stringify(left[i])}, Durable Object ${JSON.stringify(right[i])}`;
  return "pages split differently";
}

export async function compareSite(
  site: string,
  log: (message: string) => void = () => {},
): Promise<string[]> {
  const owner = await db
    .selectFrom("users")
    .select(["id", "site_data_backend"])
    .where("login_name", "=", site)
    .executeTakeFirst();
  if (!owner) throw new Error(`No Naru site is named ${site}.`);
  if (owner.site_data_backend !== "postgres")
    throw new Error(`${site} is ${owner.site_data_backend}, not postgres.`);
  const snapshot = await postgresSnapshot(owner.id);
  const scratch = `compare:${site}`;
  await callSiteDataWorker(scratch, "import", snapshot);
  const differences: string[] = [];
  try {
    for (const collection of snapshot.collections) {
      const documents = snapshot.documents
        .filter((document) => document.collection_id === collection.id)
        .map((document) => JSON.parse(document.data));
      const queries = comparisonQueries(documents);
      log(
        `${collection.name}: ${documents.length} documents, ${queries.length} queries`,
      );
      for (const query of queries) {
        const request = {
          path: [collection.name],
          method: "GET",
          size: PAGE_SIZE,
          ...query,
        };
        const expected = await readAll(
          (after) =>
            executeData({
              site,
              adminUserId: owner.id,
              ...request,
              after,
            }) as Promise<Page>,
        );
        const actual = await readAll(
          async (after) =>
            (
              await callSiteDataWorker<{ result: Page }>(scratch, "execute", {
                ownerId: String(owner.id),
                access: { admin: true, allowedIds: null, anonymous: false },
                ...request,
                after,
              })
            ).result,
        );
        if (!isDeepStrictEqual(expected, actual))
          differences.push(
            `${collection.name} ${JSON.stringify(query)}: ${firstDifference(expected, actual)}`,
          );
      }
    }
  } finally {
    await callSiteDataWorker(scratch, "erase", {});
  }
  return differences;
}
