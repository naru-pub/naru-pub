import { randomBytes } from "crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A UUID from a URL or request body, normalized to lower case, or null for
// anything else — so a malformed id is a 400/404, not a database cast error.
export function parseUuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value)
    ? value.toLowerCase()
    : null;
}

// RFC 9562 UUIDv7, for ids the application makes before the row exists (an
// uploaded file's object key, a client registration). Same layout as the
// database's uuid_v7(): 48 bits of Unix milliseconds, the version, 12 bits
// that keep ids from one process in order within a millisecond (a counter
// here, where uuid_v7() uses sub-millisecond time), then random bits with
// the variant.
let lastMs = 0;
let sequence = 0;

export function uuidv7(now = Date.now()): string {
  let ms = Math.max(now, lastMs);
  if (ms === lastMs) {
    sequence += 1;
    if (sequence > 0xfff) {
      ms += 1;
      sequence = 0;
    }
  } else {
    sequence = 0;
  }
  lastMs = ms;

  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | (sequence >> 8);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
