import { createHash } from "node:crypto";
import { DataError, NAME } from "./validation";

export type FilterValue = string | number | boolean | null;
export const MAX_FILTER_BYTES = 2048;

export function parseWhereQuery(raw: string | null): unknown {
  if (raw === null) return undefined;
  if (Buffer.byteLength(raw) > MAX_FILTER_BYTES)
    throw new DataError(400, "Filter exceeds 2048 bytes.");
  try {
    return JSON.parse(raw);
  } catch {
    throw new DataError(400, "where must be a JSON object.");
  }
}

export function filters(input: unknown) {
  if (input === undefined)
    return {
      entries: [] as [string, FilterValue][],
      json: "{}",
      fingerprint: undefined,
    };
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new DataError(400, "where must be a JSON object.");
  const entries = Object.entries(input).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (entries.length > 5)
    throw new DataError(400, "Use at most 5 equality filters.");
  for (const [key, value] of entries) {
    if (
      !NAME.test(key) ||
      !(
        value === null ||
        typeof value === "boolean" ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))
      )
    )
      throw new DataError(
        400,
        "Filter keys must be top-level field names; values must be strings, finite numbers, booleans or null.",
      );
    if (
      typeof value === "string" &&
      (value.includes("\u0000") || !value.isWellFormed())
    )
      throw new DataError(400, "Invalid filter string.");
  }
  const json = JSON.stringify(Object.fromEntries(entries));
  if (Buffer.byteLength(json) > MAX_FILTER_BYTES)
    throw new DataError(400, "Filter exceeds 2048 bytes.");
  return {
    entries: entries as [string, FilterValue][],
    json,
    fingerprint: entries.length
      ? createHash("sha256").update(json).digest("base64url")
      : undefined,
  };
}
