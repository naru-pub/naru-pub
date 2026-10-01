import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { db } from "@/lib/database";
import { listObjects } from "@/lib/board/storage";
import { templatePrefix } from "@/lib/board/preview";
import { s3Client } from "@/lib/s3";

// Template files and previews are stored under _templates/<template id>/, in
// the site bucket and the screenshots bucket. Templates that existed before
// 1790824144110 got new ids, so their objects are copied from the old number's
// prefix to the new id's. Copied, not moved: preview URLs already handed out
// keep working. Safe to run again: it only overwrites its own copies.
//
//   node dist/cli/copy-legacy-template-storage.mjs
async function main() {
  const templates = await db
    .selectFrom("legacy_ids")
    .select(["old_id", "new_id"])
    .where("table_name", "=", "board_templates")
    .execute();

  const buckets = [
    process.env.S3_BUCKET_NAME!,
    process.env.S3_BUCKET_NAME_SCREENSHOTS!,
  ];
  let copied = 0;
  for (const { old_id, new_id } of templates) {
    const from = templatePrefix(String(old_id));
    const to = templatePrefix(new_id);
    for (const bucket of buckets) {
      for (const object of await listObjects(from, bucket)) {
        await s3Client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            // The copy source is a URL path, so each segment is encoded.
            CopySource: `${bucket}/${object.key.split("/").map(encodeURIComponent).join("/")}`,
            Key: to + object.key.slice(from.length),
          }),
        );
        copied += 1;
      }
    }
    console.log(
      `[copy-legacy-template-storage] template ${old_id} -> ${new_id}`,
    );
  }
  console.log(
    `[copy-legacy-template-storage] ${templates.length} template(s), ${copied} object(s) copied`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[copy-legacy-template-storage] fatal:", error);
    process.exit(1);
  });
