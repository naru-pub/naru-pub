import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { NextRequest } from "next/server";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Validates that the request is a legitimate JSON API call, not a form submission.
 * Uses two layers of defense:
 *
 * 1. Content-Type check: Forms can only send application/x-www-form-urlencoded,
 *    multipart/form-data, or text/plain - not application/json.
 *    This blocks same-origin form attacks. The media type itself is compared,
 *    since a no-cors fetch may send "text/plain; x=application/json".
 *
 * 2. assertSameOriginRequest.
 */
export function assertJsonContentType(request: NextRequest): void {
  // Check 1: Content-Type must be application/json
  const mediaType = request.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new Error("Content-Type must be application/json");
  }

  // Check 2: Sec-Fetch-Site must be same-origin (if header present)
  assertSameOriginRequest(request);
}

/**
 * Rejects requests a browser sent from another origin. Sec-Fetch-Site is set
 * by the browser and cannot be forged by a page. "same-site" is refused too:
 * naru.pub is not a public suffix, so <login>.naru.pub is the same site as the
 * control plane and its requests carry the session cookie (SameSite=Lax does
 * not stop them).
 *
 * For mutating routes whose body can't go through assertJsonContentType, such
 * as multipart uploads or requests with no body.
 */
export function assertSameOriginRequest(request: Request): void {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin") {
    throw new Error("Invalid request: cross-origin requests not allowed");
  }
}
