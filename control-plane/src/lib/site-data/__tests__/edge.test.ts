/** @jest-environment node */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { sql } from "kysely";

// The Worker stands in: one object stalls once, another keeps failing, and
// the custom domain tables it is sent are kept.
const mockCalls: string[] = [];
const domainTables: {
  confirmedUntil: number;
  domains: Record<string, { login: string; entitledUntil: number | null }>;
}[] = [];
jest.mock("@/lib/edge/client", () => ({
  CONFIRMATION_MS: 60_000,
  replaceEdgeDomains: jest.fn(async (table: (typeof domainTables)[number]) => {
    domainTables.push(table);
    return null;
  }),
  callSiteObject: jest.fn(async (site: string) => {
    mockCalls.push(site);
    if (
      site === "broken" ||
      (site === "flaky" && mockCalls.filter((s) => s === "flaky").length === 1)
    )
      throw new Error(`${site} is unavailable`);
    return { documents: 3, bytes: 120 };
  }),
}));
const { db } = require("@/lib/database") as typeof import("@/lib/database");
const { syncEdge } =
  require("@/lib/edge/sync") as typeof import("@/lib/edge/sync");
const { setupTestDatabase, teardownTestDatabase } =
  require("./test-database") as typeof import("./test-database");

const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;
integration("site-data edge sync", () => {
  let initialized = false;
  beforeAll(async () => {
    await setupTestDatabase();
    initialized = true;
    for (const login of ["steady", "flaky", "broken"])
      await sql`insert into users(login_name) values (${login})`.execute(db);
    // Neither complimentary nor paid in the last 60 days: not synced.
    await sql`insert into users(login_name, supporter_comp) values ('lapsed', false)`.execute(
      db,
    );
  });
  afterAll(async () => {
    if (initialized) await teardownTestDatabase();
    await db.destroy();
  });

  test("a site that fails once is retried after the others; only a repeated failure is reported", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await syncEdge();
      expect(result).toEqual({
        sites: 3,
        retried: 2,
        failures: ["broken"],
        domains: 0,
      });
      // The retries come after every other site has had its turn.
      expect(mockCalls.slice(-2).sort()).toEqual(["broken", "flaky"]);
      expect(mockCalls).not.toContain("lapsed");
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
    const usage = await db
      .selectFrom("users")
      .select(["login_name", "site_data_document_count"])
      .orderBy("login_name")
      .execute();
    expect(
      Object.fromEntries(
        usage.map((row) => [
          row.login_name,
          Number(row.site_data_document_count),
        ]),
      ),
    ).toEqual({ broken: 0, flaky: 3, lapsed: 0, steady: 3 });
  });
});
