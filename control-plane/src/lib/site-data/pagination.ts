import { DataError, name, NAME } from "./validation";

export type OrderBy = "id" | "created_at" | "updated_at";
export type Direction = "asc" | "desc";
export function sorting(orderBy = "id", direction = "asc") {
  if (
    !["id", "created_at", "updated_at"].includes(orderBy) ||
    !["asc", "desc"].includes(direction)
  )
    throw new DataError(
      400,
      "Use orderBy=id, created_at or updated_at and direction=asc or desc.",
    );
  return { orderBy: orderBy as OrderBy, direction: direction as Direction };
}

export function encodeCursor(
  collection: number,
  orderBy: OrderBy,
  direction: Direction,
  id: string,
  value: string | null,
  fingerprint?: string,
) {
  return (
    "v1." +
    Buffer.from(
      JSON.stringify({
        c: collection,
        s: orderBy,
        d: direction,
        i: id,
        t: value,
        f: fingerprint,
      }),
    ).toString("base64url")
  );
}
export function decodeCursor(
  after: string | undefined,
  collection: number,
  orderBy: OrderBy,
  direction: Direction,
  fingerprint?: string,
) {
  if (after === undefined) return null;
  // Retain compatibility with the original ID-ascending pagination API.
  if (
    !fingerprint &&
    NAME.test(after) &&
    orderBy === "id" &&
    direction === "asc"
  )
    return { id: after, value: null };
  try {
    if (after.length > 1024 || !/^v1\.[A-Za-z0-9_-]+$/.test(after))
      throw new Error();
    const cursor = JSON.parse(
      Buffer.from(after.slice(3), "base64url").toString("utf8"),
    );
    if (
      cursor.c !== collection ||
      cursor.s !== orderBy ||
      cursor.d !== direction ||
      cursor.f !== fingerprint
    )
      throw new Error();
    name(cursor.i);
    if (orderBy === "id") {
      if (cursor.t !== null) throw new Error();
    } else {
      // Preserve PostgreSQL microseconds; Date alone would lose cursor precision.
      if (
        typeof cursor.t !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.t) ||
        new Date(cursor.t).toISOString() !== cursor.t.slice(0, 23) + "Z"
      )
        throw new Error();
    }
    return { id: cursor.i as string, value: cursor.t as string | null };
  } catch {
    throw new DataError(
      400,
      "Invalid cursor or cursor does not match this collection, sort order and filters.",
    );
  }
}
