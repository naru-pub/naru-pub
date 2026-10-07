/** @jest-environment node */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { up, down } from "@/migrations/1791377967407_site_data_usage_counters";
import { executeBatch, executeData } from "../service";
import { MAX_DOCUMENT_BYTES, MAX_SITE_BYTES } from "../validation";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";

const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;
integration("transactional site usage counters", () => {
  let ready = false;
  let owner: string;
  const call = (
    method: string,
    path: string[],
    body?: Record<string, unknown>,
  ) => executeData({ site: "alice", adminUserId: owner, method, path, body });
  const batch = (operations: unknown[]) =>
    executeBatch({
      site: "alice",
      adminUserId: owner,
      method: "POST",
      path: ["_batch"],
      body: { operations },
    });
  const usage = async () => {
    const row = await db
      .selectFrom("users")
      .select(["site_data_bytes_used", "site_data_document_count"])
      .where("id", "=", owner)
      .executeTakeFirstOrThrow();
    const actual = (
      await sql<{
        bytes: string;
        documents: string;
      }>`select coalesce(sum(d.size_bytes), 0)::text as bytes, count(d.id)::text as documents from site_data_collections c left join site_data_documents d on d.collection_id=c.id where c.user_id=${owner}`.execute(
        db,
      )
    ).rows[0];
    expect(String(row.site_data_bytes_used)).toBe(actual.bytes);
    expect(String(row.site_data_document_count)).toBe(actual.documents);
    return {
      bytes: Number(row.site_data_bytes_used),
      documents: Number(row.site_data_document_count),
    };
  };
  beforeAll(async () => {
    await setupTestDatabase();
    ready = true;
    owner = (
      await sql<{
        id: string;
      }>`insert into users(login_name) values ('alice') returning id`.execute(
        db,
      )
    ).rows[0].id;
  });
  beforeEach(async () => {
    await db.deleteFrom("site_data_collections").execute();
    await call("POST", [], { name: "posts" });
  });
  afterAll(async () => {
    try {
      if (ready) await teardownTestDatabase();
    } finally {
      await db.destroy();
    }
  });

  test("backfills existing documents and down preserves their content", async () => {
    await call("PUT", ["posts", "old"], { data: true });
    await down(db);
    await sql`insert into site_data_documents(collection_id,id,data,size_bytes) select id, 'seed', '{"x":1}'::jsonb, 7 from site_data_collections`.execute(
      db,
    );
    // Production migrator runs each migration transactionally too.
    await db.transaction().execute((tx) => up(tx));
    expect(await usage()).toEqual({ bytes: 11, documents: 2 });
    expect((await call("GET", ["posts", "seed"])).document).toMatchObject({
      data: { x: 1 },
    });
  });
  test("creates, replaces with different/equal sizes, and missing deletes", async () => {
    await call("PUT", ["posts", "a"], { data: "abc" });
    expect(await usage()).toEqual({ bytes: 5, documents: 1 });
    await call("PUT", ["posts", "a"], { data: "longer" });
    expect(await usage()).toEqual({ bytes: 8, documents: 1 });
    await call("PUT", ["posts", "a"], { data: "short!" });
    expect(await usage()).toEqual({ bytes: 8, documents: 1 });
    await call("DELETE", ["posts", "missing"]);
    expect(await usage()).toEqual({ bytes: 8, documents: 1 });
    await call("DELETE", ["posts", "a"]);
    expect(await usage()).toEqual({ bytes: 0, documents: 0 });
  });
  test("bulk raw SQL updates and collection cascades maintain counters", async () => {
    await sql`insert into site_data_documents(collection_id,id,data,size_bytes) select c.id, n::text, '{}'::jsonb, 2 from site_data_collections c cross join generate_series(1,100) n`.execute(
      db,
    );
    expect(await usage()).toEqual({ bytes: 200, documents: 100 });
    await sql`update site_data_documents set data='null'::jsonb, size_bytes=4`.execute(
      db,
    );
    expect(await usage()).toEqual({ bytes: 400, documents: 100 });
    await call("DELETE", ["posts"]);
    expect(await usage()).toEqual({ bytes: 0, documents: 0 });
  });
  test("batch repeated IDs and deletes use the final net usage", async () => {
    await batch([
      { collection: "posts", type: "set", id: "a", data: "first" },
      { collection: "posts", type: "set", id: "a", data: 123 },
      { collection: "posts", type: "set", id: "b", data: true },
      { collection: "posts", type: "delete", id: "b" },
      { collection: "posts", type: "delete", id: "missing" },
    ]);
    expect(await usage()).toEqual({ bytes: 3, documents: 1 });
    await expect(
      batch([
        { collection: "posts", type: "set", id: "a", data: "changed" },
        { collection: "posts", type: "delete", id: "a", ifVersion: 999 },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await usage()).toEqual({ bytes: 3, documents: 1 });
  });
  test("grouped writes return ordered results across collections and advance revisions", async () => {
    await call("POST", [], { name: "second" });
    await call("PUT", ["posts", "same"], { data: "old" });
    await call("PUT", ["posts", "gone"], { data: "remove" });
    const result = await batch([
      { collection: "second", type: "set", id: "same", data: true },
      { collection: "posts", type: "delete", id: "gone" },
      { collection: "posts", type: "set", id: "same", data: "replacement" },
      { collection: "second", type: "delete", id: "missing" },
      { collection: "posts", type: "set", id: "new", data: null },
    ]);
    expect(result.results).toEqual([
      {
        id: "same",
        version: 1,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
      null,
      {
        id: "same",
        version: 2,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
      null,
      {
        id: "new",
        version: 1,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
    ]);
    expect((await call("GET", ["posts", "same"])).document).toMatchObject({
      data: "replacement",
      version: 2,
    });
    expect((await call("GET", ["second", "same"])).document).toMatchObject({
      data: true,
      version: 1,
    });
    expect(await usage()).toEqual({ bytes: 21, documents: 3 });
  });
  test("repeated conditional writes observe preceding versions in operation order", async () => {
    const result = await batch([
      { collection: "posts", type: "set", id: "same", data: 1, ifVersion: 0 },
      { collection: "posts", type: "set", id: "same", data: 22, ifVersion: 1 },
      { collection: "posts", type: "delete", id: "same", ifVersion: 2 },
      { collection: "posts", type: "set", id: "same", data: 333, ifVersion: 0 },
    ]);
    expect(result.results.map((row) => row?.version ?? null)).toEqual([
      1,
      2,
      null,
      1,
    ]);
    expect(await usage()).toEqual({ bytes: 3, documents: 1 });
  });
  test("grouped deletes return null for every requested key", async () => {
    await batch([
      { collection: "posts", type: "set", id: "a", data: 1 },
      { collection: "posts", type: "set", id: "b", data: 22 },
    ]);
    const result = await batch([
      { collection: "posts", type: "delete", id: "b" },
      { collection: "posts", type: "delete", id: "missing" },
      { collection: "posts", type: "delete", id: "a" },
    ]);
    expect(result.results).toEqual([null, null, null]);
    expect(await usage()).toEqual({ bytes: 0, documents: 0 });
  });
  test("byte quota rejects single/batch writes and rolls back their counters", async () => {
    const collection = await db
      .selectFrom("site_data_collections")
      .select("id")
      .where("name", "=", "posts")
      .executeTakeFirstOrThrow();
    await sql`insert into site_data_documents(collection_id,id,data,size_bytes) select ${collection.id}::integer, 'seed' || n, '{}'::jsonb, ${MAX_DOCUMENT_BYTES}::integer from generate_series(1,${MAX_SITE_BYTES / MAX_DOCUMENT_BYTES}::integer) n`.execute(
      db,
    );
    const full = await usage();
    expect(full.bytes).toBe(MAX_SITE_BYTES);
    await expect(
      call("PUT", ["posts", "extra"], { data: 1 }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expect(
      batch([{ collection: "posts", type: "set", id: "extra", data: 1 }]),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(await usage()).toEqual(full);
    await call("PUT", ["posts", "seed1"], { data: 1 });
    await call("PUT", ["posts", "extra"], { data: 2 });
    expect((await usage()).bytes).toBe(MAX_SITE_BYTES - MAX_DOCUMENT_BYTES + 2);
  });
  test("grouped mixed writes enforce final usage and roll back deletes on quota failure", async () => {
    const collection = await db
      .selectFrom("site_data_collections")
      .select("id")
      .where("name", "=", "posts")
      .executeTakeFirstOrThrow();
    await sql`insert into site_data_documents(collection_id,id,data,size_bytes) select ${collection.id}::integer, 'seed' || n, '{}'::jsonb, ${MAX_DOCUMENT_BYTES}::integer from generate_series(1,${MAX_SITE_BYTES / MAX_DOCUMENT_BYTES}::integer) n`.execute(
      db,
    );
    const maximum = "x".repeat(MAX_DOCUMENT_BYTES - 2);
    await batch([
      { collection: "posts", type: "set", id: "replacement", data: maximum },
      { collection: "posts", type: "delete", id: "seed1" },
    ]);
    const full = await usage();
    expect(full).toEqual({
      bytes: MAX_SITE_BYTES,
      documents: MAX_SITE_BYTES / MAX_DOCUMENT_BYTES,
    });
    await expect(
      batch([
        { collection: "posts", type: "delete", id: "seed2" },
        { collection: "posts", type: "set", id: "extra1", data: maximum },
        { collection: "posts", type: "set", id: "extra2", data: maximum },
      ]),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(await usage()).toEqual(full);
    expect((await call("GET", ["posts", "seed2"])).document).toMatchObject({
      data: {},
    });
    for (const id of ["extra1", "extra2"])
      await expect(call("GET", ["posts", id])).rejects.toMatchObject({
        status: 404,
      });
  });
  test("moving raw documents between owners applies both deltas", async () => {
    await sql`insert into users(login_name) values ('bob')`.execute(db);
    await sql`insert into site_data_collections(user_id,name) select id, 'other' from users where login_name='bob'`.execute(
      db,
    );
    await call("PUT", ["posts", "a"], { data: 123 });
    await sql`update site_data_documents set collection_id=(select id from site_data_collections where name='other')`.execute(
      db,
    );
    expect(await usage()).toEqual({ bytes: 0, documents: 0 });
    const bob = await db
      .selectFrom("users")
      .select(["site_data_bytes_used", "site_data_document_count"])
      .where("login_name", "=", "bob")
      .executeTakeFirstOrThrow();
    expect(Number(bob.site_data_bytes_used)).toBe(3);
    expect(Number(bob.site_data_document_count)).toBe(1);
    await db.deleteFrom("users").where("login_name", "=", "bob").execute();
    expect(await usage()).toEqual({ bytes: 0, documents: 0 });
  });
});
