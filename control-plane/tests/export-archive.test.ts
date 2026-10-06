import { test } from "node:test";
import assert from "node:assert/strict";
import archiver from "archiver";
import { PassThrough, Readable } from "node:stream";
import { appendExportFile } from "../src/lib/export-archive.ts";

test("an entry consumes its source before the next download starts", async () => {
  const archive = archiver("zip");
  archive.resume();
  const source = new PassThrough();
  let completed = false;
  const entry = appendExportFile(archive, source, "first.txt").then(() => {
    completed = true;
  });
  source.write("first");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  source.end("second");
  await entry;
  assert.equal(source.readableEnded, true);
  await appendExportFile(archive, Readable.from(["next"]), "next.txt");
  await archive.finalize();
});

test("a failed download rejects instead of producing a successful partial export", async () => {
  const archive = archiver("zip");
  archive.resume();
  const source = new PassThrough();
  const entry = appendExportFile(archive, source, "broken.txt");
  source.destroy(new Error("download interrupted"));
  await assert.rejects(entry, /download interrupted/);
  archive.abort();
});
