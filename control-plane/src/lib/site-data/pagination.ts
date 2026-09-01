import { DataError, name, NAME } from "./validation";

export type Column = "id" | "created_at" | "updated_at";
export type Direction = "asc" | "desc";
export type Sort = {
  /** Cursor identity: the caller's orderBy verbatim. */
  orderBy: string;
  direction: Direction;
  /** Set when ordering by a document field rather than a column. */
  field?: string;
};
const COLUMNS: Column[] = ["id", "created_at", "updated_at"];
const DATA_ORDER = /^data\.([a-zA-Z0-9_-]{1,64})$/;

export function sorting(orderBy = "id", direction = "asc"): Sort {
  if (!["asc", "desc"].includes(direction))
    throw new DataError(400, "Use direction=asc or desc.");
  const field = DATA_ORDER.exec(orderBy)?.[1];
  if (!field && !COLUMNS.includes(orderBy as Column))
    throw new DataError(
      400,
      "Use orderBy=id, created_at, updated_at or data.<field>.",
    );
  return { orderBy, direction: direction as Direction, field };
}

export function encodeCursor(
  collection: number,
  sort: Sort,
  id: string,
  value: string | null,
  fingerprint?: string,
) {
  return (
    "v1." +
    Buffer.from(
      JSON.stringify({
        c: collection,
        s: sort.orderBy,
        d: sort.direction,
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
  sort: Sort,
  fingerprint?: string,
) {
  if (after === undefined) return null;
  // Retain compatibility with the original ID-ascending pagination API.
  if (
    !fingerprint &&
    NAME.test(after) &&
    sort.orderBy === "id" &&
    sort.direction === "asc"
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
      cursor.s !== sort.orderBy ||
      cursor.d !== sort.direction ||
      cursor.f !== fingerprint
    )
      throw new Error();
    name(cursor.i);
    if (sort.field) {
      // The anchor is the field's JSONB text, compared as JSONB again on the
      // way in, so PostgreSQL's own rendering round-trips exactly.
      if (typeof cursor.t !== "string") throw new Error();
      JSON.parse(cursor.t);
    } else if (sort.orderBy === "id") {
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
