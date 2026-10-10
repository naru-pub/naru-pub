// The browser a pageview's user agent names, as the analytics page groups
// them. The pageview-rollup migration classified the raw pageviews it
// replaced with the same rules in SQL.
export function browserName(ua: string | null): string {
  if (!ua) return "(알 수 없음)";
  // Order matters: check more specific strings first
  if (ua.includes("Firefox/") && !ua.includes("Seamonkey/")) return "Firefox";
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("OPR/") || ua.includes("Opera/")) return "Opera";
  if (ua.includes("SamsungBrowser/")) return "Samsung Internet";
  if (ua.includes("Chrome/")) return "Chrome";
  if (ua.includes("Safari/") && !ua.includes("Chromium/")) return "Safari";
  if (
    ua.includes("bot") ||
    ua.includes("Bot") ||
    ua.includes("crawl") ||
    ua.includes("Crawl") ||
    ua.includes("spider") ||
    ua.includes("Spider")
  )
    return "Bot";
  if (ua.includes("curl/")) return "curl";
  return "(기타)";
}
