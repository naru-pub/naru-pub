import * as Sentry from "@sentry/nextjs";
import { getSiteBucketUrl, getUserObjectKey } from "@/lib/site-urls";

// After a site's files change, Cloudflare's copies of them go. The edge
// Worker serves HTML, JS and JSON itself, uncached, so only the other files
// are cached: they redirect to the bucket's public domain, r2.naru.pub, and
// it is there they are purged. A failed purge only delays a change, so it is
// reported and not thrown.

/** Purges these paths of the user's site from the bucket's public domain. */
export function purgeSiteFiles(loginName: string, paths: string[]) {
  return purgeUrls(
    paths.map((path) =>
      getSiteBucketUrl(
        // As a browser requests it after the edge's redirect.
        getUserObjectKey(loginName, path)
          .split("/")
          .map(encodeURIComponent)
          .join("/"),
      ),
    ),
  );
}

/** Purges URLs from Cloudflare's cache, 30 per call as the API allows. */
export async function purgeUrls(urls: string[]): Promise<void> {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const apiToken = process.env.CLOUDFLARE_USER_API_TOKEN;
  if (!zoneId || !apiToken) return;
  for (let i = 0; i < urls.length; i += 30) {
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
          },
          body: JSON.stringify({ files: urls.slice(i, i + 30) }),
        },
      );
      if (!response.ok) {
        Sentry.captureMessage(
          `Cloudflare purge failed: ${response.status} ${await response.text()}`,
        );
      }
    } catch (error) {
      Sentry.captureException(error);
    }
  }
}
