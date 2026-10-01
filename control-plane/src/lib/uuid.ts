const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A UUID from a URL or request body, normalized to lower case, or null for
// anything else — so a malformed id is a 400/404, not a database cast error.
export function parseUuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value)
    ? value.toLowerCase()
    : null;
}
