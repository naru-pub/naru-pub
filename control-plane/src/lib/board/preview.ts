// Where templates live in storage, and their preview images. Apart from
// templates.ts so the screenshot CLI can use them without the web server's
// modules.

import { getSiteBucketUrl } from "@/lib/site-urls";

// A template's snapshots, in the site bucket.
export function templatePrefix(templateId: string): string {
  return `_templates/${templateId}/`;
}

export function templateFileKey(
  templateId: string,
  version: number,
  path: string,
): string {
  return `${templatePrefix(templateId)}v${version}/${path}`;
}

// Previews live in the site bucket beside the version's files.
export function templatePreviewKey(templateId: string, version: number) {
  return `${templatePrefix(templateId)}v${version}.png`;
}

export function getTemplatePreviewUrl(
  templateId: string,
  version: number,
  renderedAt: Date | string | null,
): string | null {
  if (!renderedAt) return null;
  const stamp = new Date(renderedAt).getTime();
  return `${getSiteBucketUrl(templatePreviewKey(templateId, version))}?v=${stamp}`;
}
