export const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
export const MAX_DOCUMENT_BYTES = 64 * 1024;
export const MAX_SITE_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS = 10000;
export const MAX_COLLECTIONS = 100;

/**
 * The failure codes of the v1 data protocol. A browser SDK released against
 * v1 knows exactly these, so a new one needs a new protocol version; HTTP
 * statuses stay diagnostic.
 */
export const ERROR_CODES = [
  "CONFLICT",
  "QUOTA_EXCEEDED",
  "AUTH_REQUIRED",
  "ACCESS_DENIED",
  "NOT_FOUND",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "UNAVAILABLE",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class DataError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Only where the status alone would name the wrong code. */
    public code?: ErrorCode,
  ) {
    super(message);
  }
}

function statusCode(status: number): ErrorCode {
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) return "ACCESS_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UNAVAILABLE";
  return "INVALID_REQUEST";
}

/** The v1 error body: `{ error: { code, message } }`. */
export function protocolError(
  status: number,
  message: string,
  code?: ErrorCode,
  headers?: HeadersInit,
) {
  return Response.json(
    { error: { code: code ?? statusCode(status), message } },
    { status, headers },
  );
}

/**
 * A collection name. Names starting with an underscore are reserved for the
 * protocol's own paths (`_batch`, `_files`), which a collection would shadow.
 */
export function unreservedName(value: unknown): string {
  const result = name(value);
  if (result.startsWith("_"))
    throw new DataError(400, "Collection names cannot start with _.");
  return result;
}

export function name(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new DataError(
      400,
      "Names must contain 1–64 letters, numbers, underscores or hyphens.",
    );
  }
  return value;
}

export function permission(value: unknown): "admin" | "world" {
  if (value !== "admin" && value !== "world")
    throw new DataError(400, "Invalid permission.");
  return value;
}

/** `refusal` says what a visitor cannot do, and where that is changed. */
export function authorize(
  access: string,
  admin: boolean,
  refusal = "Permission denied.",
) {
  if (!admin && access !== "world") throw new DataError(403, refusal);
}

export function writePermission(value: unknown): "admin" | "world" | "create" {
  return value === "create" ? "create" : permission(value);
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  // Next can reconstruct request.url with its internal localhost address behind
  // a reverse proxy. Use an explicit canonical origin in production, never a
  // client-controlled forwarded host header, for owner authorization.
  const configured =
    process.env.SITE_DATA_CONTROL_PLANE_ORIGIN ||
    (process.env.NODE_ENV === "production"
      ? `https://${process.env.NEXT_PUBLIC_DOMAIN || "naru.pub"}`
      : null);
  const expectedOrigin = new URL(configured || request.url).origin;
  if (
    (origin && origin !== expectedOrigin) ||
    (!origin && request.method !== "GET") ||
    ["cross-site", "same-site"].includes(
      request.headers.get("sec-fetch-site") ?? "",
    )
  ) {
    throw new DataError(403, "Same-origin admin request required.");
  }
}

// Bound the stream, not just Content-Length (which clients can omit or forge).
export async function jsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  ) {
    throw new DataError(415, "Use application/json.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new DataError(400, "JSON body required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new DataError(413, "Request exceeds 64 KiB.");
    }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw new DataError(400, "Expected a JSON object.");
  }
}

/** Canonical UUID syntax; accepts historical v4 and current v7 identities. */
export function uuidId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new DataError(400, "Invalid UUID identifier.");
  }
  return value.toLowerCase();
}
