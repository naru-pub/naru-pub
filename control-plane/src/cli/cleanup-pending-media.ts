import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { s3Client } from "@/lib/utils";

async function main() {
  const bucket = process.env.SITE_DATA_MEDIA_BUCKET || "naru-media";
  const pending = await db
    .selectFrom("site_data_files")
    .select(["id", "object_key"])
    .where("status", "=", "pending")
    .where("created_at", "<", sql<Date>`now() - interval '1 hour'`)
    .orderBy("created_at")
    .limit(1000)
    .execute();
  let removed = 0;
  for (const file of pending) {
    try {
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: file.object_key }),
      );
      await db
        .deleteFrom("site_data_files")
        .where("id", "=", file.id)
        .where("status", "=", "pending")
        .execute();
      removed++;
    } catch (error) {
      console.error(`[media-cleanup] Failed ${file.id}`, error);
    }
  }
  console.log(
    `[media-cleanup] Removed ${removed}/${pending.length} pending uploads`,
  );
}

main().finally(() => db.destroy());
