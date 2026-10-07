// Where a flow may send someone back to after login, signup or verifying an
// email: only these in-app pages, never a URL the link supplies (an open
// redirect). A path is returned with its query string.
const RETURN_PATHS = new Set(["/supporter", "/database/authorize"]);

export function safeNextPath(next: string | null | undefined): string | null {
  if (!next) return null;
  try {
    const base = "https://naru.invalid";
    const url = new URL(next, base);
    if (url.origin !== base || !RETURN_PATHS.has(url.pathname)) return null;
    return url.pathname + url.search;
  } catch {
    return null;
  }
}
