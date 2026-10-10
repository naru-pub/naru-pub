import { randomBytes } from "node:crypto";
import { db } from "@/lib/database";
import { deleteObjects, listObjects } from "@/lib/board/storage";

// Home directory exports are zips in the site bucket, and r2.naru.pub serves
// that whole bucket to anyone who knows a key. The emailed presigned link is
// meant to be the only way to a zip, so each one sits under a random 128-bit
// token: nothing about the login or the time it was made finds it.
export const EXPORT_PREFIX = "__exports/";

export function newExportKey(loginName: string): string {
  const token = randomBytes(16).toString("base64url");
  return `${EXPORT_PREFIX}${token}/${loginName}-export.zip`;
}

// Zips made before the random keys were named after the login.
function legacyExportPrefix(loginName: string): string {
  return `${EXPORT_PREFIX}${loginName}/`;
}

// Account deletion removes the home directory, not the exports beside it, and
// the export rows go with the user, so the expiry job would never find these.
export async function deleteUserExports(
  userId: string,
  loginName: string,
): Promise<void> {
  const rows = await db
    .selectFrom("home_directory_exports")
    .select("r2_key")
    .where("user_id", "=", userId)
    .where("r2_key", "is not", null)
    .execute();
  const legacy = await listObjects(legacyExportPrefix(loginName));
  await deleteObjects([
    ...rows.map((row) => row.r2_key!),
    ...legacy.map((object) => object.key),
  ]);
}

export function unreferencedExportKeys(
  stored: string[],
  referenced: Iterable<string>,
): string[] {
  const kept = new Set(referenced);
  return stored.filter((key) => !kept.has(key));
}

// A zip no export row points at: left by an account deleted before exports
// were removed with it, or by a run killed between uploading the zip and
// recording it. Maintenance runs the export job one at a time, so when this
// runs no export is between those two steps.
export async function deleteUnreferencedExports(): Promise<number> {
  const stored = await listObjects(EXPORT_PREFIX);
  if (stored.length === 0) return 0;
  const rows = await db
    .selectFrom("home_directory_exports")
    .select("r2_key")
    .where("r2_key", "is not", null)
    .execute();
  const orphans = unreferencedExportKeys(
    stored.map((object) => object.key),
    rows.map((row) => row.r2_key!),
  );
  await deleteObjects(orphans);
  return orphans.length;
}
