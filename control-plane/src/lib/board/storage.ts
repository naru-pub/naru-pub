import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { s3Client } from "@/lib/s3";

// The R2 operations templates need, in the site bucket. Kept apart so the
// template logic can be tested against an in-memory bucket.

function bucket() {
  return process.env.S3_BUCKET_NAME!;
}

export interface StoredObject {
  key: string;
  size: number;
}

export async function listObjects(
  prefix: string,
  bucketName = bucket(),
): Promise<StoredObject[]> {
  const objects: StoredObject[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key) objects.push({ key: object.Key, size: object.Size ?? 0 });
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return objects;
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch (error: any) {
    if (
      error?.name === "NotFound" ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return false;
    }
    throw error;
  }
}

export async function copyObject(
  sourceKey: string,
  targetKey: string,
  contentType?: string,
): Promise<void> {
  await s3Client.send(
    new CopyObjectCommand({
      Bucket: bucket(),
      // The copy source is a URL path, so each segment is encoded.
      CopySource: `${bucket()}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
      Key: targetKey,
      ...(contentType
        ? { ContentType: contentType, MetadataDirective: "REPLACE" }
        : {}),
    }),
  );
}

export async function deleteObjects(
  keys: string[],
  bucketName = bucket(),
): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    if (batch.length === 0) continue;
    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      }),
    );
  }
}

export async function deletePrefix(
  prefix: string,
  bucketName = bucket(),
): Promise<void> {
  const objects = await listObjects(prefix, bucketName);
  await deleteObjects(
    objects.map((object) => object.key),
    bucketName,
  );
}

// Through this module, which tests replace, like the bucket operations above.
export { purgeSiteFiles } from "@/lib/cache-purge";
