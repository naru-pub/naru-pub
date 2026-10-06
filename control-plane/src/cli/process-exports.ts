import { db } from "@/lib/database";
import { s3Client } from "@/lib/s3";
import { getUserHomeDirectory } from "@/lib/site-urls";
import {
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { sendExportReadyEmail } from "@/lib/email";
import archiver from "archiver";
import { sql } from "kysely";
import { createWriteStream, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { readFile } from "fs/promises";
import { recoverInterruptedExports } from "@/lib/export-recovery";
import { appendExportFile } from "@/lib/export-archive";

async function processExport(exportRow: { id: string; user_id: string }) {
  const user = await db
    .selectFrom("users")
    .select(["login_name", "email"])
    .where("id", "=", exportRow.user_id)
    .executeTakeFirst();

  if (!user || !user.email) {
    throw new Error(`User ${exportRow.user_id} not found or has no email`);
  }

  const userDirectory = getUserHomeDirectory(user.login_name);
  const bucketName = process.env.S3_BUCKET_NAME!;

  // List all objects
  const allObjects: { Key: string; Size: number }[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: `${userDirectory}/`,
        ContinuationToken: continuationToken,
      }),
    );

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key) {
          allObjects.push({ Key: obj.Key, Size: obj.Size || 0 });
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  if (allObjects.length === 0) {
    throw new Error(`No files found for user ${user.login_name}`);
  }

  // Create ZIP in temp file
  const tmpPath = join(tmpdir(), `export-${exportRow.id}-${Date.now()}.zip`);
  const output = createWriteStream(tmpPath);
  const archive = archiver("zip", { zlib: { level: 6 } });

  const archiveComplete = new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
    output.on("error", reject);
  });

  // Observe failures immediately, including while a source is downloading.
  void archiveComplete.catch(() => {});
  archive.pipe(output);

  try {
    // Add files one at a time to avoid socket exhaustion
    for (const obj of allObjects) {
      const relativePath = obj.Key.replace(`${userDirectory}/`, "");
      if (!relativePath || relativePath === obj.Key) continue;

      const response = await s3Client.send(
        new GetObjectCommand({ Bucket: bucketName, Key: obj.Key }),
      );
      if (!response.Body) throw new Error(`Empty response for ${obj.Key}`);
      // Wait until this entry is consumed before opening another R2 socket.
      await Promise.race([
        appendExportFile(
          archive,
          Readable.from(response.Body as any),
          relativePath,
        ),
        archiveComplete.then(() => {
          throw new Error("ZIP output closed before export finished");
        }),
      ]);
    }

    await archive.finalize();
    await archiveComplete;

    // Upload ZIP to R2
    const timestamp = Date.now();
    const r2Key = `__exports/${user.login_name}/export-${timestamp}.zip`;
    const zipBuffer = await readFile(tmpPath);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: r2Key,
        Body: zipBuffer,
        ContentType: "application/zip",
      }),
    );

    // Update row
    const downloadExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours

    await db
      .updateTable("home_directory_exports")
      .set({
        status: "completed",
        r2_key: r2Key,
        size_bytes: zipBuffer.length,
        download_expires_at: downloadExpiresAt,
        completed_at: new Date(),
      })
      .where("id", "=", exportRow.id)
      .execute();

    try {
      // Generate presigned URL for email (72h TTL)
      const downloadUrl = await getSignedUrl(
        s3Client as any,
        new GetObjectCommand({
          Bucket: bucketName,
          Key: r2Key,
          ResponseContentDisposition: `attachment; filename="${user.login_name}-export.zip"`,
        }) as any,
        { expiresIn: 72 * 60 * 60 },
      );
      await sendExportReadyEmail(user.email, downloadUrl, user.login_name);
    } catch (error) {
      // The ZIP is ready even if email delivery fails.
      console.error(`[export] Ready email failed for ${exportRow.id}:`, error);
    }

    console.log(
      `[export] Completed export ${exportRow.id} for ${user.login_name} (${zipBuffer.length} bytes)`,
    );
  } finally {
    archive.abort();
    output.destroy();
    try {
      unlinkSync(tmpPath);
    } catch {}
  }
}

async function processPendingExports() {
  // Maintenance serializes runs and kills each child after 30 minutes.
  // A five-minute margin keeps live attempts out of recovery, while retries
  // and deployment catch-up can reclaim rows left by killed processes.
  const recovered = await recoverInterruptedExports(db);
  if (recovered)
    console.log(`[export] Requeued ${recovered} interrupted export(s)`);
  const pendingExports = await db
    .selectFrom("home_directory_exports")
    .select(["id", "user_id"])
    .where("status", "=", "pending")
    .orderBy("created_at", "asc")
    .execute();

  if (pendingExports.length === 0) {
    return;
  }

  console.log(`[export] Found ${pendingExports.length} pending export(s)`);

  for (const exportRow of pendingExports) {
    try {
      await db
        .updateTable("home_directory_exports")
        .set({ status: "in_progress", started_at: new Date() })
        .where("id", "=", exportRow.id)
        .execute();

      await processExport(exportRow);
    } catch (error) {
      console.error(`[export] Failed export ${exportRow.id}:`, error);
      await db
        .updateTable("home_directory_exports")
        .set({
          status: "failed",
          error_message:
            error instanceof Error ? error.message : "Unknown error",
        })
        .where("id", "=", exportRow.id)
        .execute();
    }
  }
}

async function cleanupExpiredExports() {
  const expiredExports = await db
    .selectFrom("home_directory_exports")
    .select(["id", "r2_key"])
    .where((eb) =>
      eb.or([
        eb.and([
          eb("status", "=", "completed"),
          eb("download_expires_at", "<", sql<Date>`now()`),
        ]),
        eb.and([
          eb("status", "=", "failed"),
          eb("created_at", "<", sql<Date>`now() - interval '7 days'`),
        ]),
      ]),
    )
    .execute();

  if (expiredExports.length === 0) {
    return;
  }

  console.log(
    `[export] Cleaning up ${expiredExports.length} expired export(s)`,
  );

  for (const exportRow of expiredExports) {
    // Delete R2 object if exists
    if (exportRow.r2_key) {
      try {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: exportRow.r2_key,
          }),
        );
      } catch (error) {
        console.error(
          `[export] Failed to delete R2 object ${exportRow.r2_key}:`,
          error,
        );
      }
    }

    // Delete DB row
    await db
      .deleteFrom("home_directory_exports")
      .where("id", "=", exportRow.id)
      .execute();
  }
}

async function main() {
  try {
    await processPendingExports();
    await cleanupExpiredExports();
  } catch (error) {
    console.error("[export] Fatal error:", error);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

main();
