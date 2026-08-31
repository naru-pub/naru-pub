import archiver from "archiver";
import path from "node:path";
import { PassThrough } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-static";

export async function GET() {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => {
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    output.on("end", () => resolve(Buffer.concat(chunks)));
    output.on("error", reject);
    archive.on("error", reject);
    archive.on("warning", reject);
  });
  archive.pipe(output);
  const directory = path.join(process.cwd(), "public/examples/database-blog");
  for (const name of [
    "README.md",
    "config.js",
    "client.js",
    "utils.js",
    "style.css",
    "index.html",
    "post.html",
    "guestbook.html",
    "admin.html",
    "list.js",
    "post.js",
    "admin.js",
    "editor.js",
  ]) {
    archive.file(path.join(directory, name), {
      name,
      date: new Date("2026-08-31T00:00:00Z"),
    });
  }
  await Promise.all([archive.finalize(), complete]);
  const zip = await complete;
  return new Response(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="naru-database-blog.zip"',
      "Cache-Control": "no-cache",
    },
  });
}
