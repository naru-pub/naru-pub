import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { s3Client } from "@/lib/s3";

// Media live under <user id>/ in the media bucket. Files uploaded before
// 1790824144110 are under the user's old sequence number instead. This moves
// each one to its user's id, points its row at the new key, and rewrites the
// site-data documents that link to the old URL. There is no redirect: a link
// to the old URL anywhere else (a site's own files) stops working once the
// old object is deleted, which is done only with --delete-old. Safe to run
// again: files already moved are skipped, and only links to a file that has
// moved are rewritten.
//
//   node dist/cli/move-legacy-media-keys.mjs              copy, update rows and documents
//   node dist/cli/move-legacy-media-keys.mjs --delete-old  then delete the old objects
//   node dist/cli/move-legacy-media-keys.mjs --dry-run     only report what it would do
const bucket = process.env.SITE_DATA_MEDIA_BUCKET || "naru-media";
const origin = (
  process.env.SITE_DATA_MEDIA_ORIGIN || "https://media.naru.pub"
).replace(/\/$/, "");
const deleteOld = process.argv.includes("--delete-old");
const dryRun = process.argv.includes("--dry-run");
const log = (message: string) =>
  console.log(`[move-legacy-media-keys] ${message}`);

async function exists(key: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error: any) {
    if (error?.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

// A media URL keyed by a sequence number: <origin>/<number>/<file name>.
const LEGACY_URL = new RegExp(
  `${origin.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/(\\d+)/([A-Za-z0-9._-]+)`,
  "g",
);

// Rewrites every string in a document, keeping its shape.
function rewrite(value: unknown, moved: Map<string, string>): unknown {
  if (typeof value === "string")
    return value.replace(LEGACY_URL, (url, number, name) => {
      const key = moved.get(`${number}/${name}`);
      return key ? `${origin}/${key}` : url;
    });
  if (Array.isArray(value)) return value.map((item) => rewrite(item, moved));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, rewrite(v, moved)]),
    );
  return value;
}

async function main() {
  const legacy = await db
    .selectFrom("site_data_files as f")
    .innerJoin("legacy_ids as l", (join) =>
      join.onRef("l.new_id", "=", "f.user_id").on("l.table_name", "=", "users"),
    )
    .select(["f.id", "f.user_id", "f.object_key", "l.old_id"])
    .execute();

  // Old key -> new key, for every file whose key now names its user's id,
  // including ones moved by an earlier run.
  const moved = new Map<string, string>();
  for (const file of legacy) {
    const [prefix, ...rest] = file.object_key.split("/");
    const name = rest.join("/");
    const oldKey = `${file.old_id}/${name}`;
    const newKey = `${file.user_id}/${name}`;
    if (prefix === file.user_id) {
      moved.set(oldKey, newKey);
      continue;
    }
    if (prefix !== String(file.old_id)) continue;
    moved.set(oldKey, newKey);
    log(`${oldKey} -> ${newKey}`);
    if (dryRun) continue;
    if (await exists(oldKey)) {
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${oldKey}`,
          Key: newKey,
        }),
      );
    } else {
      log(`no object for ${oldKey}; updating the row only`);
    }
    await db
      .updateTable("site_data_files")
      .set({ object_key: newKey })
      .where("id", "=", file.id)
      .where("object_key", "=", oldKey)
      .execute();
  }

  // Documents are rewritten in place: the version advances so a conditional
  // write quoting the old one is refused, but updated_at is the owner's last
  // edit and stays.
  const documents = await db
    .selectFrom("site_data_documents")
    .select(["collection_id", "id", "data", "version"])
    .where(
      sql<boolean>`data::text ~ ${`${origin.replace(/\./g, "\\.")}/[0-9]+/`}`,
    )
    .execute();
  let rewritten = 0;
  for (const document of documents) {
    const data = rewrite(document.data, moved);
    const encoded = JSON.stringify(data);
    if (encoded === JSON.stringify(document.data)) continue;
    if (dryRun) {
      const links = JSON.stringify(document.data).match(LEGACY_URL)?.length;
      log(`would rewrite ${links} link(s) in document ${document.id}`);
      rewritten += 1;
      continue;
    }
    const result = await db
      .updateTable("site_data_documents")
      .set({
        data: sql`${encoded}::jsonb`,
        size_bytes: Buffer.byteLength(encoded),
        version: sql`version + 1`,
      })
      .where("collection_id", "=", document.collection_id)
      .where("id", "=", document.id)
      .where("version", "=", document.version)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      log(`document ${document.id} changed meanwhile; run again`);
    } else {
      rewritten += 1;
    }
  }
  log(
    `${moved.size} file(s) under their user's id, ${rewritten} document(s) rewritten`,
  );

  if (deleteOld && !dryRun) {
    for (const oldKey of moved.keys()) {
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: oldKey }),
      );
    }
    log(`${moved.size} old object(s) deleted`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[move-legacy-media-keys] fatal:", error);
    process.exit(1);
  });
