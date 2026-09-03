import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { s3Client } from "@/lib/utils";
import { previewFeatureAccess, userHasFeature } from "@/lib/entitlements";
import { noteSupporterFeatureUse } from "@/lib/feature-usage";
import { tokenScope } from "./owner-auth";
import { DataError, name } from "./validation";

export const MAX_MEDIA_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MEDIA_SITE_BYTES = 250 * 1024 * 1024;
export const MAX_MEDIA_FILES = 1000;
const mediaBucket = () => process.env.SITE_DATA_MEDIA_BUCKET || "naru-media";
const mediaOrigin = () =>
  (process.env.SITE_DATA_MEDIA_ORIGIN || "https://media.naru.pub").replace(
    /\/$/,
    "",
  );
const allowedTypes = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "application/pdf",
  "application/zip",
  "text/plain",
]);

type MediaCommand = {
  site: string;
  path: string[];
  method: string;
  adminUserId?: number;
  bearer?: { token: string; origin: string | null };
  body?: Record<string, unknown>;
};

function publicUrl(objectKey: string) {
  return `${mediaOrigin()}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}
function output(file: {
  id: string;
  object_key: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
  status: string;
  metadata: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}) {
  return {
    id: file.id,
    name: file.original_name,
    contentType: file.content_type,
    size: file.size_bytes,
    status: file.status,
    metadata: file.metadata,
    url: publicUrl(file.object_key),
    created_at: file.created_at,
    updated_at: file.updated_at,
  };
}
function uploadInput(body: Record<string, unknown>) {
  const filename = typeof body.name === "string" ? body.name.trim() : "";
  const contentType =
    typeof body.contentType === "string" ? body.contentType.toLowerCase() : "";
  const size = body.size;
  if (!filename || filename.length > 255 || /[\u0000-\u001f]/.test(filename))
    throw new DataError(
      400,
      "File name must contain 1–255 printable characters.",
    );
  if (!allowedTypes.has(contentType))
    throw new DataError(415, "File type is not supported.");
  if (
    !Number.isInteger(size) ||
    Number(size) < 1 ||
    Number(size) > MAX_MEDIA_FILE_BYTES
  )
    throw new DataError(413, "File must be between 1 byte and 25 MiB.");
  const metadata =
    body.metadata &&
    typeof body.metadata === "object" &&
    !Array.isArray(body.metadata)
      ? body.metadata
      : {};
  const encodedMetadata = JSON.stringify(metadata);
  if (Buffer.byteLength(encodedMetadata) > 8192)
    throw new DataError(413, "File metadata exceeds 8 KiB.");
  return { filename, contentType, size: Number(size), metadata };
}

export async function executeMedia(command: MediaCommand) {
  if (command.path.length > 1) throw new DataError(404, "Not found.");
  const owner = await db
    .selectFrom("users")
    .select(["id", "supporter_comp"])
    .where("login_name", "=", command.site)
    .executeTakeFirst();
  if (!owner) throw new DataError(404, "Site not found.");
  const preview = previewFeatureAccess(!!owner.supporter_comp, "database");
  if (!(preview ?? (await userHasFeature(owner.id, "database"))))
    throw new DataError(403, "Database access is not enabled for this site.");
  // Uploading or removing a file is the owner using the supporter storage;
  // serving one back is a visitor reading their site.
  if (command.method !== "GET") noteSupporterFeatureUse(owner.id, "database");
  const allowedIds = command.bearer
    ? await db
        .transaction()
        .execute((tx) =>
          tokenScope(
            tx,
            owner.id,
            command.bearer!.token,
            command.bearer!.origin,
          ),
        )
    : undefined;
  const admin = command.adminUserId === owner.id || allowedIds !== undefined;
  if (!admin) throw new DataError(403, "Owner access required.");
  if (command.adminUserId !== undefined && command.adminUserId !== owner.id)
    throw new DataError(403, "Permission denied.");

  const files = () =>
    db.selectFrom("site_data_files").where("user_id", "=", owner.id);
  if (command.method === "GET" && command.path.length === 0) {
    const [rows, usage] = await Promise.all([
      files()
        .where("status", "=", "ready")
        .selectAll()
        .orderBy("created_at", "desc")
        .limit(MAX_MEDIA_FILES)
        .execute(),
      files()
        .select([
          sql<number>`coalesce(sum(size_bytes), 0)`.as("bytes"),
          sql<number>`count(*)`.as("count"),
          sql<number>`count(*) filter (where status = 'pending')`.as("pending"),
        ])
        .executeTakeFirstOrThrow(),
    ]);
    return {
      files: rows.map(output),
      usage: {
        bytes: Number(usage.bytes),
        count: Number(usage.count),
        pending: Number(usage.pending),
        maxBytes: MAX_MEDIA_SITE_BYTES,
        maxFiles: MAX_MEDIA_FILES,
      },
    };
  }
  const id = command.path[0] ? name(command.path[0]) : undefined;
  if (command.method === "GET" && id) {
    const file = await files()
      .where("id", "=", id)
      .where("status", "=", "ready")
      .selectAll()
      .executeTakeFirst();
    if (!file) throw new DataError(404, "File not found.");
    return { file: output(file) };
  }
  if (command.method === "POST" && command.path.length === 0) {
    const input = uploadInput(command.body || {});
    const fileId = randomUUID();
    const extension = input.filename.includes(".")
      ? input.filename
          .split(".")
          .pop()!
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 10)
      : "";
    const objectKey = `${owner.id}/${fileId}${extension ? `.${extension}` : ""}`;
    const file = await db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("users")
        .select("id")
        .where("id", "=", owner.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const usage = await tx
        .selectFrom("site_data_files")
        .where("user_id", "=", owner.id)
        .select([
          sql<number>`coalesce(sum(size_bytes), 0)`.as("bytes"),
          sql<number>`count(*)`.as("count"),
        ])
        .executeTakeFirstOrThrow();
      if (
        Number(usage.count) >= MAX_MEDIA_FILES ||
        Number(usage.bytes) + input.size > MAX_MEDIA_SITE_BYTES
      )
        throw new DataError(409, "Media storage quota exceeded.");
      return tx
        .insertInto("site_data_files")
        .values({
          id: fileId,
          user_id: owner.id,
          object_key: objectKey,
          original_name: input.filename,
          content_type: input.contentType,
          size_bytes: input.size,
          metadata: input.metadata,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    try {
      const uploadUrl = await getSignedUrl(
        // Smithy package versions differ between the S3 client and presigner.
        s3Client as never,
        new PutObjectCommand({
          Bucket: mediaBucket(),
          Key: objectKey,
          ContentType: input.contentType,
        }) as never,
        { expiresIn: 10 * 60 },
      );
      return {
        file: output(file),
        uploadUrl,
        method: "PUT",
        headers: { "Content-Type": input.contentType },
      };
    } catch (error) {
      await db.deleteFrom("site_data_files").where("id", "=", fileId).execute();
      throw error;
    }
  }
  if (command.method === "PUT" && id) {
    const file = await files()
      .where("id", "=", id)
      .selectAll()
      .executeTakeFirst();
    if (!file) throw new DataError(404, "File not found.");
    let head;
    try {
      head = await s3Client.send(
        new HeadObjectCommand({ Bucket: mediaBucket(), Key: file.object_key }),
      );
    } catch {
      throw new DataError(409, "Upload has not completed.");
    }
    if (
      head.ContentLength !== file.size_bytes ||
      head.ContentType !== file.content_type
    ) {
      await s3Client
        .send(
          new DeleteObjectCommand({
            Bucket: mediaBucket(),
            Key: file.object_key,
          }),
        )
        .catch(() => {});
      await db.deleteFrom("site_data_files").where("id", "=", id).execute();
      throw new DataError(
        409,
        "Uploaded file does not match its authorization.",
      );
    }
    const ready = await db
      .updateTable("site_data_files")
      .where("id", "=", id)
      .set({ status: "ready", updated_at: new Date() })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { file: output(ready) };
  }
  if (command.method === "DELETE" && id) {
    const file = await files()
      .where("id", "=", id)
      .selectAll()
      .executeTakeFirst();
    if (!file) return { success: true };
    await s3Client.send(
      new DeleteObjectCommand({ Bucket: mediaBucket(), Key: file.object_key }),
    );
    await db.deleteFrom("site_data_files").where("id", "=", id).execute();
    return { success: true };
  }
  throw new DataError(405, "Method not allowed.");
}

export async function deleteUserMedia(userId: number) {
  let continuationToken: string | undefined;
  do {
    const page = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: mediaBucket(),
        Prefix: `${userId}/`,
        ContinuationToken: continuationToken,
      }),
    );
    if (page.Contents?.length) {
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: mediaBucket(),
          Delete: {
            Objects: page.Contents.map((object) => ({ Key: object.Key! })),
          },
        }),
      );
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
}
