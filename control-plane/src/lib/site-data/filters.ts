import { createHash } from "node:crypto";
import { DataError, NAME } from "./validation";

export type FilterValue = string | number | boolean | null;
export type RangeBound = string | number;
export type ComparisonOperator = "gt" | "gte" | "lt" | "lte";
// Fixed lookup: the SQL operator is never derived from caller-supplied text.
export const COMPARISONS: Record<ComparisonOperator, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};
export const MAX_FILTER_BYTES = 2048;
export const MAX_FILTER_PREDICATES = 5;

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

function isScalar(value: unknown): value is FilterValue {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function checkString<T>(value: T): T {
  if (
    typeof value === "string" &&
    (value.includes("\u0000") || !value.isWellFormed())
  )
    throw new DataError(400, "Invalid filter string.");
  return value;
}

function comparisons(field: string, input: Record<string, unknown>) {
  const operators = Object.entries(input).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (!operators.length)
    throw new DataError(400, "Comparison objects need at least one operator.");
  const parsed: [string, ComparisonOperator, RangeBound][] = [];
  for (const [operator, bound] of operators) {
    if (!Object.hasOwn(COMPARISONS, operator))
      throw new DataError(
        400,
        "Use gt, gte, lt or lte for range comparisons.",
        "UNSUPPORTED_FILTER",
      );
    if (
      !(
        typeof bound === "string" ||
        (typeof bound === "number" && Number.isFinite(bound))
      )
    )
      throw new DataError(
        400,
        "Range bounds must be strings or finite numbers.",
      );
    // JSONB orders every number above every string, so a range mixing the two
    // would silently select on type rather than on value.
    if (parsed.length && typeof parsed[0][2] !== typeof bound)
      throw new DataError(400, "Range bounds on one field must share a type.");
    parsed.push([field, operator as ComparisonOperator, checkString(bound)]);
  }
  return { parsed, canonical: Object.fromEntries(operators) };
}

export function filters(input: unknown) {
  const empty = {
    entries: [] as [string, FilterValue][],
    ranges: [] as [string, ComparisonOperator, RangeBound][],
    json: "{}",
    fingerprint: undefined as string | undefined,
  };
  if (input === undefined) return empty;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new DataError(400, "where must be a JSON object.");
  const fields = Object.entries(input).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const entries: [string, FilterValue][] = [];
  const ranges: [string, ComparisonOperator, RangeBound][] = [];
  const canonical: Record<string, unknown> = {};
  for (const [field, value] of fields) {
    if (!NAME.test(field))
      throw new DataError(
        400,
        "Filter keys must be top-level field names; values must be strings, finite numbers, booleans, null or a comparison object.",
      );
    if (isScalar(value)) {
      entries.push([field, checkString(value)]);
      canonical[field] = value;
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new DataError(
        400,
        "Filter keys must be top-level field names; values must be strings, finite numbers, booleans, null or a comparison object.",
      );
    const range = comparisons(field, value as Record<string, unknown>);
    ranges.push(...range.parsed);
    canonical[field] = range.canonical;
  }
  if (entries.length + ranges.length > MAX_FILTER_PREDICATES)
    throw new DataError(
      400,
      `Use at most ${MAX_FILTER_PREDICATES} filter predicates.`,
    );
  // Equality alone can use the containment index, so it keeps its own payload.
  const json = JSON.stringify(Object.fromEntries(entries));
  const canonicalJson = JSON.stringify(canonical);
  if (Buffer.byteLength(canonicalJson) > MAX_FILTER_BYTES)
    throw new DataError(400, "Filter exceeds 2048 bytes.");
  return {
    entries,
    ranges,
    json,
    fingerprint:
      entries.length || ranges.length
        ? createHash("sha256").update(canonicalJson).digest("base64url")
        : undefined,
  };
}
