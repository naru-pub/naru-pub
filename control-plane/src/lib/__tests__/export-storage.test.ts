/** @jest-environment node */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const bucket = new Set<string>();
const rows: { user_id: string; r2_key: string | null }[] = [];

jest.mock("@/lib/board/storage", () => ({
  listObjects: async (prefix: string) =>
    [...bucket]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, size: 1 })),
  deleteObjects: async (keys: string[]) => {
    for (const key of keys) bucket.delete(key);
  },
}));

// Just the query shapes export-storage builds: one table, equality and
// is-not-null filters.
jest.mock("@/lib/database", () => {
  const query = (filters: ((row: any) => boolean)[]) => ({
    select: () => query(filters),
    where: (column: string, op: string, value: unknown) =>
      query([
        ...filters,
        (row: any) =>
          op === "is not" ? row[column] !== value : row[column] === value,
      ]),
    execute: async () => rows.filter((row) => filters.every((f) => f(row))),
  });
  return { db: { selectFrom: () => query([]) } };
});

// Required after the mocks: this transform does not hoist jest.mock above
// imports.
const {
  EXPORT_PREFIX,
  deleteUnreferencedExports,
  deleteUserExports,
  newExportKey,
  unreferencedExportKeys,
} = require("../export-storage") as typeof import("../export-storage");

beforeEach(() => {
  bucket.clear();
  rows.length = 0;
});

describe("export keys", () => {
  test("say nothing guessable about the login or the time", () => {
    const first = newExportKey("alice");
    const second = newExportKey("alice");
    expect(first).not.toBe(second);
    const match = /^__exports\/([A-Za-z0-9_-]{22})\/alice-export\.zip$/.exec(
      first,
    );
    // 16 random bytes, base64url: the token is the whole of the directory.
    expect(match).not.toBeNull();
    expect(first).not.toMatch(/__exports\/alice\//);
  });

  test("an unreferenced key is one no export row records", () => {
    expect(
      unreferencedExportKeys(
        ["__exports/a/x.zip", "__exports/b/y.zip"],
        ["__exports/b/y.zip"],
      ),
    ).toEqual(["__exports/a/x.zip"]);
  });
});

describe("deleting a user's exports", () => {
  test("removes their recorded zips and any under the old login prefix", async () => {
    const mine = newExportKey("alice");
    const theirs = newExportKey("bob");
    bucket.add(mine);
    bucket.add(theirs);
    bucket.add(`${EXPORT_PREFIX}alice/export-1.zip`);
    bucket.add(`${EXPORT_PREFIX}alice-two/export-2.zip`);
    rows.push(
      { user_id: "u-alice", r2_key: mine },
      { user_id: "u-alice", r2_key: null },
      { user_id: "u-bob", r2_key: theirs },
    );

    await deleteUserExports("u-alice", "alice");

    // Another login that merely starts with "alice" is not theirs.
    expect([...bucket].sort()).toEqual(
      [theirs, `${EXPORT_PREFIX}alice-two/export-2.zip`].sort(),
    );
  });
});

describe("the sweep", () => {
  test("deletes zips no row points at and keeps the rest", async () => {
    const kept = newExportKey("alice");
    const orphan = newExportKey("gone");
    bucket.add(kept);
    bucket.add(orphan);
    bucket.add(`${EXPORT_PREFIX}gone/export-1.zip`);
    bucket.add("alice/index.html");
    rows.push({ user_id: "u-alice", r2_key: kept });

    expect(await deleteUnreferencedExports()).toBe(2);
    expect([...bucket].sort()).toEqual(["alice/index.html", kept].sort());
  });
});
