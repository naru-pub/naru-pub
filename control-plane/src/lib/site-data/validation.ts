export const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
export const MAX_DOCUMENT_BYTES = 64 * 1024;
export const MAX_SITE_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS = 10000;
export const MAX_COLLECTIONS = 100;

export class DataError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
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

export function authorize(access: string, admin: boolean) {
  if (!admin && access !== "world")
    throw new DataError(403, "Permission denied.");
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
