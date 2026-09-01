import { test } from "node:test";
import assert from "node:assert/strict";
// Node's ESM resolver does not guess extensions, and this suite runs under
// `node --test` rather than Jest.
import { streamUpload, uploadFiles } from "../src/lib/upload-progress.ts";

const files = [
  new File(["first"], "first.html"),
  new File(["second"], "second.css"),
];
async function events(stream: ReadableStream<Uint8Array>) {
  return (await new Response(stream).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
test("server progress advances only after each file is saved and finalizes once", async () => {
  let resolve!: (value: { success: boolean; message: string }) => void;
  let finalized = 0;
  const stream = streamUpload(
    files,
    async (file) =>
      file === files[0]
        ? new Promise((done) => {
            resolve = done;
          })
        : { success: true, message: "ok" },
    async () => {
      finalized++;
    },
  );
  const reader = stream.getReader();
  const first = JSON.parse(
    new TextDecoder().decode((await reader.read()).value),
  );
  assert.equal(first.completed, 0);
  assert.equal(first.fileName, "first.html");
  assert.equal(finalized, 0);
  resolve({ success: true, message: "ok" });
  const remaining = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    remaining.push(JSON.parse(new TextDecoder().decode(next.value)));
  }
  assert.deepEqual(
    remaining.filter((e) => e.type === "progress").map((e) => e.completed),
    [1, 1, 2, 2],
  );
  assert.equal(remaining.at(-1).success, true);
  assert.equal(finalized, 1);
});
test("partial failure reports completed count and failing file; stops remaining files", async () => {
  const attempted: string[] = [];
  let finalized = 0;
  const result = await events(
    streamUpload(
      [...files, new File(["third"], "third.js")],
      async (file) => {
        attempted.push(file.name);
        return { success: file === files[0], message: "Unsupported file" };
      },
      async () => {
        finalized++;
      },
    ),
  );
  assert.deepEqual(attempted, ["first.html", "second.css"]);
  assert.equal(finalized, 1);
  assert.equal(result.at(-1).success, false);
  assert.equal(result.at(-1).completed, 1);
  assert.match(result.at(-1).message, /second.css/);
});
test("finalization failure never reports a successful upload", async () => {
  const result = await events(
    streamUpload(
      files,
      async () => ({ success: true, message: "ok" }),
      async () => {
        throw new Error("DB offline");
      },
    ),
  );
  assert.equal(result.at(-1).success, false);
  assert.equal(result.at(-1).completed, 2);
});
test("client handles fragmented UTF-8 progress and preserves one multipart batch", async () => {
  const original = globalThis.fetch;
  const progress: any[] = [];
  globalThis.fetch = async (_url, options) => {
    assert.equal(options?.method, "POST");
    assert.equal((options?.headers as any).Accept, "application/x-ndjson");
    const form = options?.body as FormData;
    assert.equal(form.get("directory"), "blog/");
    assert.equal(form.getAll("file").length, 2);
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        type: "progress",
        completed: 1,
        total: 2,
        fileName: "\ube14\ub85c\uadf8.html",
        phase: "saving",
      }) +
        "\n" +
        JSON.stringify({
          type: "done",
          success: true,
          completed: 2,
          total: 2,
        }) +
        "\n",
    );
    return new Response(
      new ReadableStream({
        start(c) {
          for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
          c.close();
        },
      }),
      { headers: { "Content-Type": "application/x-ndjson" } },
    );
  };
  try {
    await uploadFiles(files, "blog", (p) => progress.push(p));
    assert.equal(progress[0].phase, "preparing");
    assert.equal(progress[1].completed, 1);
    assert.equal(progress[1].fileName, "\ube14\ub85c\uadf8.html");
  } finally {
    globalThis.fetch = original;
  }
});
test("client rejects partial failure and interrupted streams, and surfaces HTTP errors", async () => {
  const original = globalThis.fetch;
  try {
    for (const [body, status, type] of [
      [
        JSON.stringify({
          type: "done",
          success: false,
          message: "second.css failed",
          completed: 1,
          total: 2,
        }) + "\n",
        200,
        "application/x-ndjson",
      ],
      [
        JSON.stringify({ type: "progress", completed: 1, total: 2 }) + "\n",
        200,
        "application/x-ndjson",
      ],
      [
        JSON.stringify({ success: false, message: "Sign in required" }),
        401,
        "application/json",
      ],
    ] as const) {
      globalThis.fetch = async () =>
        new Response(body, { status, headers: { "Content-Type": type } });
      await assert.rejects(uploadFiles(files, "", () => {}));
    }
  } finally {
    globalThis.fetch = original;
  }
});
