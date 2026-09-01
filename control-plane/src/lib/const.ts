export const LOGIN_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const RESERVED_LOGIN_NAMES = new Set([
  "proxy",
  "custom-domains",
  // Naru Data is served from db.naru.pub; a user owning this login name would
  // shadow it.
  "db",
]);

export function isReservedLoginName(loginName: string) {
  return RESERVED_LOGIN_NAMES.has(loginName.toLowerCase());
}

export const EDITABLE_FILE_EXTENSION_MAP: Record<string, string | null> = {
  html: "html",
  htm: "html",
  xml: "xml",
  xhtml: "html",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  css: "css",
  txt: null,
  js: "javascript",
  json: "json",
};

export const FILE_EXTENSION_MIMETYPE_MAP: Record<
  | keyof typeof EDITABLE_FILE_EXTENSION_MAP
  | (typeof AUDIO_FILE_EXTENSIONS)[number]
  | (typeof IMAGE_FILE_EXTENSIONS)[number]
  | (typeof FONT_FILE_EXTENSIONS)[number],
  string
> = {
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  xhtml: "application/xhtml+xml",
  svg: "image/svg+xml",
  md: "text/markdown",
  markdown: "text/markdown",
  mdx: "text/markdown",
  css: "text/css",
  txt: "text/plain",
  js: "application/javascript",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  opus: "audio/opus",
  mid: "audio/midi",
  midi: "audio/midi",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
};

export const EDITABLE_FILE_EXTENSIONS = Object.keys(
  EDITABLE_FILE_EXTENSION_MAP
);

export const AUDIO_FILE_EXTENSIONS = [
  "ogg",
  "wav",
  "mp3",
  "opus",
  "mid",
  "midi",
];

export const IMAGE_FILE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
];

export const FONT_FILE_EXTENSIONS = [
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
];

export const ALLOWED_FILE_EXTENSIONS = [
  ...EDITABLE_FILE_EXTENSIONS,
  ...AUDIO_FILE_EXTENSIONS,
  ...IMAGE_FILE_EXTENSIONS,
  ...FONT_FILE_EXTENSIONS,
];

export const DEFAULT_INDEX_HTML = `<!DOCTYPE html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>나루</title>
  </head>
  <body>
    <h1>안녕, 세상?</h1>
  </body>
</html>
`;
