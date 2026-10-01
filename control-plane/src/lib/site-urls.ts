// Where a user's site and its files live. Kept apart from utils.ts, which is
// for the UI and route handlers, so the CLIs can use these without Next.
export function getPublicAssetUrl(username: string, filename: string) {
  const pathname = collapseSlashes(filename).replace(/^\//, "");

  return process.env.NODE_ENV === "production"
    ? `https://${username}.${process.env.NEXT_PUBLIC_DOMAIN}/${pathname}`
    : `http://${username}.${process.env.NEXT_PUBLIC_DOMAIN}/${pathname}`;
}

export function getHomepageUrl(username: string) {
  return process.env.NODE_ENV === "production"
    ? `https://${username}.${process.env.NEXT_PUBLIC_DOMAIN}`
    : `http://${username}.${process.env.NEXT_PUBLIC_DOMAIN}`;
}

// The public URL of an object in the site bucket.
export function getSiteBucketUrl(key: string) {
  return `https://r2.${process.env.NEXT_PUBLIC_DOMAIN}/${key}`;
}

// Screenshots live in the site bucket beside the sites, under a prefix no
// login name can take.
export function getSiteScreenshotKey(username: string) {
  return `_screenshots/${username}.png`;
}

export function getRenderedSiteUrl(
  username: string,
  version?: Date | string | null,
) {
  const base = getSiteBucketUrl(getSiteScreenshotKey(username));
  if (!version) return base;
  const stamp =
    version instanceof Date
      ? version.getTime()
      : Date.parse(version) || version;
  return `${base}?v=${stamp}`;
}

export function getUserHomeDirectory(loginName: string) {
  return `${loginName}`;
}

// Collapses every run of slashes to one, so "a///b" and "a/b" name the same
// object. replaceAll("//", "/") only collapsed pairs and left longer runs.
export function collapseSlashes(path: string) {
  return path.replace(/\/{2,}/g, "/");
}

// The R2 key for a path inside a user's home directory. Every read and write
// of a user's files should build keys here so they agree on the same key.
export function getUserObjectKey(loginName: string, path: string) {
  return collapseSlashes(`${getUserHomeDirectory(loginName)}/${path}`);
}
