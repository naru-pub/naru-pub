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
import { db, requestDeadline } from "@/lib/database";
import { s3Client } from "@/lib/s3";
import { previewFeatureAccess, userHasFeature } from "@/lib/entitlements";
import { noteSupporterFeatureUse } from "@/lib/feature-usage";
import { tokenScope } from "./owner-auth";
import { DataError, name } from "./validation";
import { decodeCursor, encodeCursor, sorting } from "./pagination";

export const MAX_MEDIA_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MEDIA_SITE_BYTES = 250 * 1024 * 1024;
// The byte quota alone does not bound row count: the minimum file is one byte,
// so a quota's worth of tiny files is millions of rows. Listing is paged, but
// the count still has to stop somewhere the cleanup job and the owner's own
// library screen can cope with.
export const MAX_MEDIA_FILES = 10000;
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
  pageToken?: string;
  limit?: number;
  usage?: boolean;
  where?: unknown;
};
/** Newest first is what a media library is for, and the only order offered. */
const MEDIA_SORT = sorting("createdAt", "desc");

function publicUrl(objectKey: string) {
  return `${mediaOrigin()}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}
function output(file: {
  id: string;
  object_key: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
  created_at: Date | string;
  updated_at: Date | string;
}) {
  return {
    id: file.id,
    name: file.original_name,
    contentType: file.content_type,
    size: file.size_bytes,
    url: publicUrl(file.object_key),
    createdAt: file.created_at,
    updatedAt: file.updated_at,
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
  return { filename, contentType, size: Number(size) };
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
  // Recorded only now that the caller is known to be the owner. Uploading or
  // removing a file is the owner using the supporter storage; serving one back
  // is a visitor reading their site, and a refused request is neither.
  if (command.method !== "GET") noteSupporterFeatureUse(owner.id, "database");

  const files = () =>
    db.selectFrom("site_data_files").where("user_id", "=", owner.id);
  const readUsage = async () => {
    const usage = await files()
      .select([
        sql<number>`coalesce(sum(size_bytes), 0)`.as("bytes"),
        sql<number>`count(*)`.as("count"),
        sql<number>`count(*) filter (where status = 'pending')`.as("pending"),
      ])
      .executeTakeFirstOrThrow();
    return {
      bytes: Number(usage.bytes),
      count: Number(usage.count),
      pending: Number(usage.pending),
      maxBytes: MAX_MEDIA_SITE_BYTES,
    };
  };
  if (command.method === "GET" && command.path.length === 0) {
    // A quota readout is a single aggregate row, and only the control panel's
    // own library screen shows one; website tokens are not offered it.
    if (command.usage && command.adminUserId !== undefined)
      return { usage: await readUsage() };
    // Refused rather than ignored: a caller that still filters by what a file
    // belongs to would otherwise get the whole library back, and delete it.
    if (command.where !== undefined)
      throw new DataError(400, "Files cannot be filtered.");
    const limit = command.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new DataError(400, "Limit must be 1–100.");
    // Files are not queried by what they belong to: a page records the URLs
    // it uses, and the library is only ever read newest first.
    const cursor = decodeCursor(
      command.pageToken,
      owner.id,
      MEDIA_SORT,
      undefined,
      "f",
    );
    let query = files()
      .where("status", "=", "ready")
      .selectAll()
      .select(
        sql<string>`to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          "cursor_value",
        ),
      )
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit + 1);
    if (cursor)
      query = query.where(
        sql<boolean>`(created_at, id) < (${cursor.value}::timestamptz, ${cursor.id})`,
      );
    const rows = await query.execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      files: page.map(output),
      nextPageToken:
        rows.length > limit && last
          ? encodeCursor(
              owner.id,
              MEDIA_SORT,
              last.id,
              last.cursor_value,
              undefined,
              "f",
            )
          : null,
    };
  }
  const id = command.path[0] ? name(command.path[0]) : undefined;
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
      await requestDeadline(tx);
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
      if (Number(usage.bytes) + input.size > MAX_MEDIA_SITE_BYTES)
        throw new DataError(409, "Media storage quota exceeded.");
      // Counted as well as measured: the byte quota does not bound rows, and an
      // authorization loop would otherwise mint them without limit.
      if (Number(usage.count) >= MAX_MEDIA_FILES)
        throw new DataError(409, "Media file count limit reached.");
      return tx
        .insertInto("site_data_files")
        .values({
          id: fileId,
          user_id: owner.id,
          object_key: objectKey,
          original_name: input.filename,
          content_type: input.contentType,
          size_bytes: input.size,
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
      // PUT the bytes to uploadUrl with these headers, then finalize by id.
      return {
        id: file.id,
        uploadUrl,
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
