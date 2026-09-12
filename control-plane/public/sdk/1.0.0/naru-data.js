/** Naru Data SDK 1.0.0. This release is still under active development. */
export class NaruDataError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "NaruDataError";
    this.status = status;
    this.code =
      code || (status === 401 ? "OWNER_SESSION_EXPIRED" : "REQUEST_FAILED");
  }
}
/** A latest-request-wins cancellation channel for search and navigation UIs. */
export function createRequestChannel() {
  let active;
  return Object.freeze({
    next(
      reason = new DOMException("Superseded by a newer request.", "AbortError"),
    ) {
      active?.abort(reason);
      active = new AbortController();
      return active.signal;
    },
    cancel(reason = new DOMException("Request cancelled.", "AbortError")) {
      active?.abort(reason);
      active = undefined;
    },
  });
}
// One scope keeps the deadline active until the response body has been read.
function requestScope({ signal, timeoutMs = 30000, fresh } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)
    throw new TypeError(
      "timeoutMs must be an integer between 0 and 2147483647.",
    );
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new TypeError("signal must be an AbortSignal.");
  if (fresh !== undefined && typeof fresh !== "boolean")
    throw new TypeError("fresh must be a boolean.");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = timeoutMs
    ? setTimeout(
        () =>
          controller.abort(
            new DOMException("Request timed out.", "TimeoutError"),
          ),
        timeoutMs,
      )
    : undefined;
  return {
    signal: controller.signal,
    check() {
      if (!controller.signal.aborted) return;
      const cause = controller.signal.reason;
      const timeout = cause?.name === "TimeoutError";
      const error = new NaruDataError(
        0,
        timeout ? "Request timed out." : "Request aborted.",
        timeout ? "REQUEST_TIMEOUT" : "REQUEST_ABORTED",
      );
      error.cause = cause;
      throw error;
    },
    close() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}
// Validates request options and rejects an already-cancelled call, for work that
// has no single request of its own to scope.
function precheck(options) {
  const scope = requestScope(options);
  try {
    scope.check();
  } finally {
    scope.close();
  }
}
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const idValue = (value) => typeof value === "string" && ID.test(value);
const countValue = (value) => Number.isSafeInteger(value) && value >= 0;
const loopback = (url) =>
  url.protocol === "http:" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
// An owner token is opaque, and never outlives the day the server grants.
const credentialsValue = (accessToken, expiresAt) =>
  typeof accessToken === "string" &&
  TOKEN.test(accessToken) &&
  Number.isFinite(expiresAt) &&
  expiresAt > Date.now() &&
  expiresAt <= Date.now() + DAY_MS + 60000;
const timestamp = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
// Writes carry the stamps they produced, so a caller rendering what it just
// saved never has to invent a timestamp from the browser clock.
const written = (value) =>
  object(value) &&
  idValue(value.id) &&
  Number.isSafeInteger(value.version) &&
  value.version > 0 &&
  timestamp(value.createdAt) &&
  timestamp(value.updatedAt);
const documentValue = (value) => written(value) && Object.hasOwn(value, "data");
const fileValue = (value) =>
  written(value) &&
  value.status === "ready" &&
  typeof value.name === "string" &&
  typeof value.contentType === "string" &&
  Number.isSafeInteger(value.size) &&
  value.size > 0 &&
  typeof value.url === "string" &&
  Object.hasOwn(value, "metadata");
const cursorValue = (value) =>
  value === null || (typeof value === "string" && value.length > 0);
// Every call knows the envelope it asked for; these are those envelopes.
const EXPECT = {
  written,
  success: (result) => result.success === true,
  document: (result) => documentValue(result.document),
  page: (result) =>
    Array.isArray(result.documents) &&
    result.documents.every(documentValue) &&
    cursorValue(result.nextPageToken) &&
    (result.total === undefined || countValue(result.total)),
  count: (result) => countValue(result.count),
  file: (result) => fileValue(result.file),
  filePage: (result) =>
    Array.isArray(result.files) &&
    result.files.every(fileValue) &&
    cursorValue(result.nextPageToken),
  usage: (result) =>
    object(result.usage) &&
    ["bytes", "count", "pending", "maxBytes"].every((key) =>
      countValue(result.usage[key]),
    ),
  uploadAuthorization(result) {
    let upload;
    try {
      upload = new URL(result.uploadUrl);
    } catch {
      return false;
    }
    return (
      object(result.file) &&
      idValue(result.file.id) &&
      result.file.status === "pending" &&
      result.method === "PUT" &&
      object(result.headers) &&
      Object.values(result.headers).every(
        (value) => typeof value === "string",
      ) &&
      !upload.username &&
      !upload.password &&
      (upload.protocol === "https:" || loopback(upload))
    );
  },
};
function invalidResponse(status) {
  return new NaruDataError(
    status,
    "Invalid response from the database.",
    "INVALID_RESPONSE",
  );
}
// Reject values JSON.stringify would silently discard or coerce.
function validateJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value))
    throw new TypeError(
      "Data must contain only finite JSON values without cycles.",
    );
  const array = Array.isArray(value);
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new TypeError(
      "Data must use plain objects and arrays; convert dates to strings explicitly.",
    );
  ancestors.add(value);
  const keys = Reflect.ownKeys(value).filter(
    (key) => !(array && key === "length"),
  );
  if (array && keys.length !== value.length)
    throw new TypeError(
      "Data arrays must not contain holes or extra properties.",
    );
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      (array && !/^(0|[1-9][0-9]*)$/.test(key))
    )
      throw new TypeError(
        "Data must contain only enumerable JSON values, without getters or symbols.",
      );
    validateJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}
// A phone camera hands over 40 MB and 8000 px for a cover image a site will
// display at 1200. Re-encoding before the authorization request keeps the
// declared size honest, so the server's finalize check still matches, and the
// original never crosses the wire.
const DECODABLE = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  // Safari decodes what iPhones actually store. The media library rejects
  // these types, so transcoding here is the only way such a photo lands.
  "image/heic",
  "image/heif",
]);
const ENCODABLE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
function imageSettings(image = {}, original = false) {
  if (typeof original !== "boolean")
    throw new TypeError("original must be a boolean.");
  if (original) return null;
  if (!object(image)) throw new TypeError("image must be an options object.");
  const {
    maxDimension = 2048,
    quality = 0.82,
    type = "image/webp",
    maxBytes = 500 * 1024,
  } = image;
  if (
    !Number.isInteger(maxDimension) ||
    maxDimension < 1 ||
    maxDimension > 16384
  )
    throw new TypeError("maxDimension must be an integer between 1 and 16384.");
  if (typeof quality !== "number" || !(quality > 0) || quality > 1)
    throw new TypeError(
      "quality must be a number greater than 0 and at most 1.",
    );
  if (!Object.hasOwn(ENCODABLE, type))
    throw new TypeError(
      "image type must be image/webp, image/jpeg or image/png.",
    );
  if (!Number.isInteger(maxBytes) || maxBytes < 1)
    throw new TypeError("maxBytes must be a positive integer.");
  return { maxDimension, quality, type, maxBytes };
}
// Browsers substitute image/png when they cannot encode the requested type, so
// callers check blob.type before trusting it.
function encodeCanvas(canvas, { type, quality }) {
  if (typeof canvas.convertToBlob === "function")
    return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
function newCanvas(width, height) {
  if (typeof OffscreenCanvas === "function")
    return new OffscreenCanvas(width, height);
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
// Quality alone rarely reaches a byte budget from a 12 megapixel photo, and
// pixels alone throw away detail the budget could have afforded. Spend quality
// first down to a floor worth looking at, then shed pixels.
const MIN_QUALITY = 0.4;
const QUALITY_STEP = 0.12;
const ATTEMPTS = 6;
async function encodeWithin(bitmap, settings, size) {
  let [width, height] = size;
  let quality = settings.quality;
  let best;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const canvas = newCanvas(width, height);
    const context = canvas?.getContext("2d", {
      alpha: settings.type !== "image/jpeg",
    });
    if (!context) return best;
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await encodeCanvas(canvas, { type: settings.type, quality });
    // An encoder that ignored the requested type cannot be reasoned about, and
    // its bytes would be declared under a type they are not.
    if (!blob?.size || blob.type !== settings.type) return best;
    if (!best || blob.size < best.size) best = blob;
    if (blob.size <= settings.maxBytes) return blob;
    // PNG is lossless, so quality is not a dial it has; only fewer pixels help.
    if (quality > MIN_QUALITY && settings.type !== "image/png") {
      // Rounded so repeated subtraction does not drift into 0.45999999999999996.
      quality = Math.max(
        MIN_QUALITY,
        Math.round((quality - QUALITY_STEP) * 100) / 100,
      );
      continue;
    }
    // Bytes track area, so each edge moves by the square root of how far over
    // the last attempt landed: never more than half at a time, and never so
    // little that rounding cancels it — landing barely over budget is exactly
    // when a step of zero would strand the result above it.
    const ratio = Math.min(
      0.95,
      Math.max(0.5, Math.sqrt(settings.maxBytes / blob.size)),
    );
    const next = [
      Math.max(1, Math.round(width * ratio)),
      Math.max(1, Math.round(height * ratio)),
    ];
    // Rounding can stall on tiny images; stop rather than spin.
    if (next[0] === width && next[1] === height) return best;
    [width, height] = next;
  }
  return best;
}
// The object key takes its extension from the name while the content type is
// declared separately; a .heic key served as WebP is a confusing public URL.
function renameExtension(name, type) {
  const dot = name.lastIndexOf(".");
  const base = (dot > 0 ? name.slice(0, dot) : name).slice(
    0,
    254 - ENCODABLE[type].length,
  );
  return `${base}.${ENCODABLE[type]}`;
}
async function downscaleImage(file, settings, onResize) {
  if (
    !settings ||
    !DECODABLE.has(file.type) ||
    typeof createImageBitmap !== "function"
  )
    return file;
  let bitmap;
  try {
    // Canvas discards EXIF, so orientation is baked in here or every portrait
    // phone photo is published on its side.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Undecodable here is not undecodable everywhere; leave the verdict to the
    // server's own type check.
    return file;
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (!longest) return file;
    const scale = Math.min(1, settings.maxDimension / longest);
    // A small hand-tuned PNG should survive byte-identical; only excess pixels
    // or excess bytes justify a lossy pass. Undecodable types have no such
    // choice, since uploading them unchanged is a rejection.
    if (
      scale === 1 &&
      file.size <= settings.maxBytes &&
      Object.hasOwn(ENCODABLE, file.type)
    )
      return file;
    const box = [
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    ];
    // Re-encoding is certain from here, and it is slow enough that a caller
    // drawing a progress bar should be told this is not the transfer yet.
    onResize?.();
    let blob = await encodeWithin(bitmap, settings, box);
    // A browser that cannot encode the requested type quietly hands back PNG
    // instead, and giving up there would ship the untouched original — the one
    // outcome this whole path exists to avoid. JPEG is the lossy format every
    // canvas implementation can produce, so it is the fallback.
    if (!blob && settings.type !== "image/jpeg")
      blob = await encodeWithin(
        bitmap,
        { ...settings, type: "image/jpeg" },
        box,
      );
    // Re-encoding an already efficient file can cost bytes; keep the smaller of
    // the two. A budget that could not be met still yields the best attempt,
    // which beats sending the original.
    if (!blob?.size || blob.size >= file.size) return file;
    // The produced type is the authority now, not the requested one.
    return new File(
      [blob],
      renameExtension(
        typeof file.name === "string" && file.name ? file.name : "upload",
        blob.type,
      ),
      { type: blob.type },
    );
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}
// fetch cannot report upload progress, so a caller that asked for it gets an
// XMLHttpRequest bound to the same cancellation scope.
function putWithProgress(authorization, file, scope, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => {
      xhr.abort();
      finish(reject, scope.signal.reason);
    };
    const finish = (settle, value) => {
      scope.signal.removeEventListener("abort", abort);
      xhr.onload = xhr.onerror = xhr.onabort = xhr.upload.onprogress = null;
      settle(value);
    };
    try {
      xhr.open(authorization.method, authorization.uploadUrl);
      for (const [key, value] of Object.entries(authorization.headers))
        xhr.setRequestHeader(key, value);
      xhr.upload.onprogress = (event) => {
        try {
          onProgress({
            loaded: event.loaded,
            total: event.lengthComputable ? event.total : file.size,
            phase: "uploading",
          });
        } catch (error) {
          finish(reject, error);
          xhr.abort();
        }
      };
      xhr.onload = () =>
        finish(resolve, {
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          url: xhr.responseURL,
        });
      xhr.onerror = () =>
        finish(reject, new TypeError("Network request failed."));
      xhr.onabort = () =>
        finish(reject, new DOMException("Upload aborted.", "AbortError"));
      scope.signal.addEventListener("abort", abort, { once: true });
      scope.check();
      xhr.send(file);
    } catch (error) {
      finish(reject, error);
    }
  });
}
const segment = (value) => {
  if (!idValue(value))
    throw new TypeError("Invalid collection or document ID.");
  return encodeURIComponent(value);
};
const checkVersion = (value) => {
  if (!Number.isInteger(value) || value < 0)
    throw new TypeError("ifVersion must be a non-negative integer.");
  return value;
};
// Conditional writes travel in the URL: DELETE has no body, and intermediaries
// are free to drop one.
const condition = (ifVersion) =>
  ifVersion === undefined ? "" : `?ifVersion=${checkVersion(ifVersion)}`;
// A patch is a fragment, so whole-document parsers cannot judge it.
function patchBody(patch, unset) {
  if (!object(patch))
    throw new TypeError("A merge patch must be a plain object.");
  validateJson(patch);
  if (unset === undefined) return { data: patch };
  if (!Array.isArray(unset) || unset.some((key) => typeof key !== "string"))
    throw new TypeError("unset must be an array of field names.");
  return { data: patch, unset };
}
// Known today. Anything else is passed through for the server to accept or
// refuse rather than rejected here: this file is versioned and, once frozen,
// a closed list would mean a client that can never use a filter the server
// later learns, no matter how long it lives.
const COMPARISONS = ["gt", "gte", "lt", "lte"];
const OPERATOR = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const ORDER_FIELDS = /^(id|createdAt|updatedAt|data\.[a-zA-Z0-9_-]{1,64})$/;
// A file has no document body to sort by, only its server metadata.
const FILE_ORDER_FIELDS = /^(id|createdAt|updatedAt)$/;
const isScalar = (value) =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));
// Mirrors the server's rules so mistakes surface before a round trip. The
// server revalidates; this never widens what the server will accept. An empty
// filter is no filter, so it is left off the request entirely.
function filterParameter(where) {
  if (where === undefined) return undefined;
  if (!object(where))
    throw new TypeError("where must be an object of filters.");
  const fields = Object.entries(where);
  if (!fields.length) return undefined;
  for (const [field, value] of fields) {
    if (!ID.test(field)) throw new TypeError(`Invalid filter field ${field}.`);
    if (isScalar(value)) continue;
    if (!object(value))
      throw new TypeError(
        "Filter values must be scalars or a comparison object.",
      );
    const bounds = Object.entries(value);
    if (!bounds.length)
      throw new TypeError("Comparison objects need at least one operator.");
    for (const [operator, bound] of bounds) {
      if (!OPERATOR.test(operator))
        throw new TypeError("Filter operators must be short lowercase names.");
      // Only the operators this version knows have a checkable bound shape.
      // An unrecognized one is the server's to judge.
      if (!COMPARISONS.includes(operator)) continue;
      if (
        !(
          typeof bound === "string" ||
          (typeof bound === "number" && Number.isFinite(bound))
        )
      )
        throw new TypeError("Range bounds must be strings or finite numbers.");
      if (typeof bound !== typeof bounds[0][1])
        throw new TypeError("Range bounds on one field must share a type.");
    }
  }
  return JSON.stringify(where);
}
function checkOrder({ orderBy, direction } = {}, fields) {
  const validPair = (pair) =>
    Array.isArray(pair) &&
    pair.length === 2 &&
    typeof pair[0] === "string" &&
    fields.test(pair[0]) &&
    (pair[1] === "asc" || pair[1] === "desc");
  if (Array.isArray(orderBy)) {
    if (
      fields !== ORDER_FIELDS ||
      orderBy.length < 1 ||
      orderBy.length > 2 ||
      !orderBy.every(validPair) ||
      new Set(orderBy.map(([field]) => field)).size !== orderBy.length ||
      orderBy.some(([field]) => field === "id")
    )
      throw new TypeError(
        "Multi-field orderBy requires one or two unique [field, direction] pairs; id is automatic.",
      );
    if (direction !== undefined)
      throw new TypeError("Do not combine direction with multi-field orderBy.");
    return;
  }
  if (
    orderBy !== undefined &&
    (typeof orderBy !== "string" || !fields.test(orderBy))
  )
    throw new TypeError(
      fields === ORDER_FIELDS
        ? "orderBy must be id, createdAt, updatedAt or data.<field>."
        : "orderBy must be id, createdAt or updatedAt.",
    );
  if (direction !== undefined && direction !== "asc" && direction !== "desc")
    throw new TypeError("direction must be asc or desc.");
}
/** One page request, spelled the same way for documents and for files. */
function pageParameters(options = {}, fields) {
  checkOrder(options, fields);
  const { limit, pageToken, includeTotal, orderBy, direction } = options;
  // No upper bound here on purpose. The server caps the page size and says so
  // in its error; a ceiling baked into a frozen client would be one this SDK
  // could never be told about again.
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    throw new TypeError("limit must be a positive integer.");
  // null is what the last page hands back, so passing it straight through
  // means the first page instead of a special case at every call site.
  if (
    pageToken !== undefined &&
    pageToken !== null &&
    (typeof pageToken !== "string" || pageToken.length === 0)
  )
    throw new TypeError("pageToken must be a non-empty string or null.");
  if (includeTotal !== undefined && typeof includeTotal !== "boolean")
    throw new TypeError("includeTotal must be a boolean.");
  const parameters = new URLSearchParams();
  const where = filterParameter(options.where);
  if (where !== undefined) parameters.set("where", where);
  if (orderBy !== undefined)
    parameters.set(
      "orderBy",
      Array.isArray(orderBy) ? JSON.stringify(orderBy) : orderBy,
    );
  if (direction !== undefined) parameters.set("direction", direction);
  parameters.set("limit", String(limit ?? 50));
  if (pageToken) parameters.set("pageToken", pageToken);
  if (includeTotal) parameters.set("includeTotal", "1");
  return parameters;
}
// `all()` reads like a loop over an array and is not one: each page is a
// request, and on a full collection that is a hundred of them against a row the
// server locks per site. A walk that stays small — one post's images, a
// category's entries — is the shape this is for. Rather than leave the
// unbounded walk available by accident, it has a ceiling that says so; a caller
// that genuinely wants everything raises it deliberately.
const DEFAULT_WALK = 1000;
function walkLimit(max) {
  if (max === undefined) return DEFAULT_WALK;
  if (max === Infinity) return Infinity;
  if (!Number.isInteger(max) || max < 1)
    throw new TypeError("max must be a positive integer or Infinity.");
  return max;
}
// Walking every page is the same job whichever collection is being walked: keep
// asking until the cursor runs out, and refuse to loop on a repeated one.
async function* walk(readPage, key, { max, ...options } = {}) {
  let pageToken = null;
  let walked = 0;
  const ceiling = walkLimit(max);
  const seen = new Set();
  do {
    const page = await readPage({ limit: 100, ...options, pageToken });
    const nextPageToken = page.nextPageToken;
    if (nextPageToken !== null && seen.has(nextPageToken))
      throw new NaruDataError(
        200,
        "Pagination cursor repeated.",
        "INVALID_PAGINATION",
      );
    if (nextPageToken !== null) seen.add(nextPageToken);
    for (const item of page[key]) {
      if (options.signal?.aborted) precheck(options);
      if (walked >= ceiling)
        throw new NaruDataError(
          200,
          `Walked ${ceiling} records without reaching the end. Narrow the ` +
            `query with where, page explicitly with list(), or pass max to ` +
            `raise this ceiling.`,
          "WALK_LIMIT_EXCEEDED",
        );
      walked += 1;
      yield item;
    }
    pageToken = nextPageToken;
  } while (pageToken);
}
const synchronous = (result, label) => {
  if (
    result !== null &&
    result !== undefined &&
    typeof result.then === "function"
  ) {
    // An async function may already have rejected. Observe that rejection
    // while refusing it synchronously.
    Promise.resolve(result).catch(() => {});
    throw new TypeError(`${label} must return synchronously.`);
  }
  return result;
};
// Snapshot own data properties without executing registry getters. Later
// mutations of the caller's registry must not change a client's definitions.
function collectionDefinitions(collections) {
  if (!object(collections))
    throw new TypeError(
      "collections must be an object of collection definitions.",
    );
  const definitions = new Map();
  for (const name of Reflect.ownKeys(collections)) {
    segment(name);
    const descriptor = Object.getOwnPropertyDescriptor(collections, name);
    if (!("value" in descriptor) || !object(descriptor.value))
      throw new TypeError(
        `Collection definition for ${name} must be an object.`,
      );
    const definition = {};
    for (const key of Reflect.ownKeys(descriptor.value)) {
      const member = Object.getOwnPropertyDescriptor(descriptor.value, key);
      if (
        (key !== "parse" && key !== "map") ||
        !("value" in member) ||
        typeof member.value !== "function"
      )
        throw new TypeError(
          `Collection ${name} takes only parse and map functions.`,
        );
      definition[key] = member.value;
    }
    definitions.set(name, Object.freeze(definition));
  }
  return definitions;
}
const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export const CONTROL_PLANE_ORIGIN = "https://naru.pub";
// A public read may be answered by a shared cache for this long after a write.
const PUBLIC_CACHE_MS = 10_000;
export function createDatabase({
  site,
  controlPlaneOrigin = CONTROL_PLANE_ORIGIN,
  collections = {},
  ...unsupported
}) {
  if (typeof site !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(site))
    throw new TypeError("A valid Naru site login name is required.");
  const base = new URL(controlPlaneOrigin);
  if (base.origin !== CONTROL_PLANE_ORIGIN && !loopback(base))
    throw new TypeError(
      "controlPlaneOrigin must be https://naru.pub or an HTTP loopback origin.",
    );
  if (Object.hasOwn(unsupported, "schemas"))
    throw new TypeError(
      "schemas is no longer supported. Validate documents with collections: { name: { parse } }.",
    );
  const definitions = collectionDefinitions(collections);
  const root = `${base.origin}/api/data/${encodeURIComponent(site)}`;
  const storageKey = `naru:owner:${base.origin}:${site}`;
  // A write can leave a ten-second public response in a shared cache. Keep this
  // browser's reads of that collection fresh for the same window, whoever
  // wrote, so nobody has to remember fresh:true after a mutation.
  const writtenUntil = new Map();
  const recentlyWritten = (name) => (writtenUntil.get(name) ?? 0) > Date.now();
  // Parsers judge whole documents on the way in as well as the way out, so a
  // page cannot store what it would refuse to read back.
  function prepareDocument(collectionName, data) {
    validateJson(data);
    const parse = definitions.get(collectionName)?.parse;
    if (parse) {
      synchronous(parse(data), `parse for ${collectionName}`);
      // A parser can mutate its argument; keep the lossless JSON contract.
      validateJson(data);
    }
    return data;
  }
  async function request(
    url,
    { method = "GET", body, token, options, expect, collections = [] } = {},
  ) {
    const scope = requestScope(options);
    try {
      scope.check();
      // Serialize before awaiting so later caller mutations cannot change the write.
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      // A public read is the same bytes for every caller, and the server marks
      // those responses cacheable; refusing the cache here would throw that
      // away and send every visitor's every read to the origin. Anything
      // carrying a credential, and anything that is not a read, still bypasses
      // the cache entirely — as does a caller that asks for `fresh`, and a read
      // of a collection this browser has just written.
      const cacheable =
        method === "GET" &&
        !token &&
        !options?.fresh &&
        !collections.some(recentlyWritten);
      let response;
      try {
        response = await fetch(url, {
          method,
          credentials: "omit",
          cache: cacheable ? "default" : "no-store",
          redirect: "error",
          headers: {
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: serialized,
          signal: scope.signal,
        });
      } catch (cause) {
        scope.check();
        const error = new NaruDataError(
          0,
          "Network request failed. Check your connection before retrying.",
        );
        error.cause = cause;
        throw error;
      }
      let result;
      try {
        result = await response.json();
      } catch (cause) {
        scope.check();
        const error = new NaruDataError(
          response.status,
          response.ok
            ? "Invalid JSON response from the database."
            : `Database request failed (HTTP ${response.status}).`,
          response.ok ? "INVALID_RESPONSE" : undefined,
        );
        error.cause = cause;
        throw error;
      }
      scope.check();
      if (!response.ok)
        throw new NaruDataError(
          response.status,
          typeof result?.error === "string"
            ? result.error
            : `Database request failed (HTTP ${response.status}).`,
          typeof result?.code === "string" ? result.code : undefined,
        );
      if (!object(result) || (expect && !expect(result)))
        throw invalidResponse(response.status);
      return result;
    } finally {
      scope.close();
      // Also after a failure: a timed-out write may still have landed.
      if (method !== "GET")
        for (const name of collections)
          writtenUntil.set(name, Date.now() + PUBLIC_CACHE_MS);
    }
  }
  // Batching and the media library both require an owner token, so an
  // anonymous client does not carry methods that could only ever be refused.
  function client(getToken = () => undefined, unauthorized = () => {}, owner) {
    const send = async (url, init) => {
      try {
        return await request(url, { ...init, token: getToken() });
      } catch (error) {
        if (error.status === 401) unauthorized();
        throw error;
      }
    };
    const api = {
      collection(collectionName, ...rest) {
        const path = `${root}/${segment(collectionName)}`;
        if (rest[0] !== undefined)
          throw new TypeError(
            "Register parse and map once in createDatabase({ collections }) instead of per handle.",
          );
        const { parse, map } = definitions.get(collectionName) ?? {};
        const names = [collectionName];
        const readDocument = (document) => {
          if (!parse && !map) return document;
          try {
            const data = parse
              ? synchronous(parse(document.data), "parse")
              : document.data;
            const parsed = { ...document, data };
            return map ? synchronous(map(parsed), "map") : parsed;
          } catch (cause) {
            const error = new NaruDataError(
              200,
              `Document ${collectionName}/${document.id} failed read validation.`,
              "DOCUMENT_VALIDATION_FAILED",
            );
            error.collection = collectionName;
            error.documentId = document.id;
            error.cause = cause;
            throw error;
          }
        };
        const list = (options = {}) =>
          send(`${path}?${pageParameters(options, ORDER_FIELDS)}`, {
            options,
            expect: EXPECT.page,
            collections: names,
          }).then((page) => ({
            ...page,
            documents: page.documents.map(readDocument),
          }));
        const write = (suffix, method, body, options) =>
          send(`${path}${suffix}`, {
            method,
            body,
            options,
            expect: method === "DELETE" ? EXPECT.success : EXPECT.written,
            collections: names,
          });
        return {
          async get(id, options) {
            const result = await send(`${path}/${segment(id)}`, {
              options,
              expect: EXPECT.document,
              collections: names,
            });
            return readDocument(result.document);
          },
          list,
          async count(options = {}) {
            // Counting has no page to order, so accepting a sort would only
            // promise something the answer cannot carry.
            if (
              options.orderBy !== undefined ||
              options.direction !== undefined
            )
              throw new TypeError("count does not take orderBy or direction.");
            const parameters = new URLSearchParams();
            const where = filterParameter(options.where);
            if (where !== undefined) parameters.set("where", where);
            parameters.set("count", "1");
            const result = await send(`${path}?${parameters}`, {
              options,
              expect: EXPECT.count,
              collections: names,
            });
            return result.count;
          },
          all(options = {}) {
            return walk(list, "documents", options);
          },
          add(data, options) {
            const prepared = prepareDocument(collectionName, data);
            return write("", "POST", { data: prepared }, options);
          },
          set(id, data, { ifVersion, ...options } = {}) {
            const prepared = prepareDocument(collectionName, data);
            return write(
              `/${segment(id)}${condition(ifVersion)}`,
              "PUT",
              { data: prepared },
              options,
            );
          },
          update(id, patch, { ifVersion, unset, ...options } = {}) {
            return write(
              `/${segment(id)}${condition(ifVersion)}`,
              "PATCH",
              patchBody(patch, unset),
              options,
            );
          },
          delete(id, { ifVersion, ...options } = {}) {
            return write(
              `/${segment(id)}${condition(ifVersion)}`,
              "DELETE",
              undefined,
              options,
            );
          },
        };
      },
    };
    // Everything below needs an owner token. An anonymous client that carried
    // these would only ever be able to be refused by the server.
    if (!owner) return api;
    api.batch = (operations, options) => {
      // The server sets and enforces the ceiling; this only rejects a shape
      // that could not be a batch at all.
      if (!Array.isArray(operations) || !operations.length)
        throw new TypeError("Batch requires at least one operation.");
      const snapshot = operations.map((operation) => {
        if (!object(operation)) throw new TypeError("Invalid batch operation.");
        const { type, collection } = operation;
        segment(collection);
        if (type === "add") {
          if (operation.id !== undefined)
            throw new TypeError("add assigns the document ID itself.");
          if (operation.ifVersion !== undefined)
            throw new TypeError("add cannot take ifVersion.");
          const data = prepareDocument(collection, operation.data);
          return { type, collection, data };
        }
        segment(operation.id);
        const target = { collection, id: operation.id };
        if (operation.ifVersion !== undefined)
          target.ifVersion = checkVersion(operation.ifVersion);
        if (type === "set")
          return {
            ...target,
            type,
            data: prepareDocument(collection, operation.data),
          };
        if (type === "update")
          return {
            ...target,
            type,
            ...patchBody(operation.data, operation.unset),
          };
        if (type === "delete") return { ...target, type };
        throw new TypeError(
          "Batch operations must be add, set, update or delete.",
        );
      });
      return send(`${root}/_batch`, {
        method: "POST",
        body: { operations: snapshot },
        options,
        expect: (result) =>
          Array.isArray(result.results) &&
          result.results.length === snapshot.length &&
          result.results.every((item, index) =>
            snapshot[index].type === "delete"
              ? EXPECT.success(item)
              : written(item),
          ),
        collections: [...new Set(snapshot.map((item) => item.collection))],
      });
    };
    const filePath = (id) => `${root}/_files/${segment(id)}`;
    const fileList = (options = {}) =>
      send(`${root}/_files?${pageParameters(options, FILE_ORDER_FIELDS)}`, {
        options,
        expect: EXPECT.filePage,
      });
    api.files = {
      async get(id, options) {
        return (await send(filePath(id), { options, expect: EXPECT.file }))
          .file;
      },
      list: fileList,
      all(options = {}) {
        return walk(fileList, "files", options);
      },
      async usage(options) {
        // A quota readout is one aggregate row; asking for it never pages the
        // library the way sharing the listing response used to.
        return (
          await send(`${root}/_files?usage=1`, {
            options,
            expect: EXPECT.usage,
          })
        ).usage;
      },
      async upload(
        source,
        { image, original, onProgress, metadata = {}, ...options } = {},
      ) {
        if (!(source instanceof Blob))
          throw new TypeError("upload requires a File or Blob.");
        if (onProgress !== undefined && typeof onProgress !== "function")
          throw new TypeError("onProgress must be a function.");
        validateJson(metadata);
        const settings = imageSettings(image, original);
        // Shrinking precedes the limit check on purpose: a 40 MB photo the
        // site would downscale for display anyway should upload, not fail.
        // It also takes seconds with no bytes moving, so it is its own phase
        // rather than a progress bar that claims to be uploading.
        let progressError;
        const file = await downscaleImage(
          source,
          settings,
          onProgress &&
            (() => {
              // A throwing callback must fail the upload, not be swallowed by
              // the resize and silently ship the original.
              try {
                onProgress({
                  loaded: 0,
                  total: source.size,
                  phase: "resizing",
                });
              } catch (error) {
                progressError = error;
              }
            }),
        );
        if (progressError) throw progressError;
        if (!file.size || file.size > 25 * 1024 * 1024)
          throw new TypeError("File must be between 1 byte and 25 MiB.");
        const scope = requestScope({ timeoutMs: 120000, ...options });
        const transferOptions = { signal: scope.signal, timeoutMs: 0 };
        let authorization;
        try {
          scope.check();
          authorization = await send(`${root}/_files`, {
            method: "POST",
            body: {
              name:
                typeof file.name === "string" && file.name
                  ? file.name
                  : "upload",
              contentType: file.type || "application/octet-stream",
              size: file.size,
              metadata,
            },
            options: transferOptions,
            expect: EXPECT.uploadAuthorization,
          });
          scope.check();
          const response =
            onProgress && typeof XMLHttpRequest !== "undefined"
              ? await putWithProgress(authorization, file, scope, onProgress)
              : await fetch(authorization.uploadUrl, {
                  method: authorization.method,
                  headers: authorization.headers,
                  credentials: "omit",
                  redirect: "error",
                  body: file,
                  signal: scope.signal,
                });
          scope.check();
          // XMLHttpRequest follows redirects silently, where the fetch path
          // refuses them outright. Bytes that ended up on another host did not
          // go where the control plane signed for them to go.
          if (
            response.url &&
            new URL(response.url).origin !==
              new URL(authorization.uploadUrl).origin
          )
            throw new NaruDataError(
              0,
              "File upload was redirected off its authorized origin.",
              "UPLOAD_REDIRECTED",
            );
          if (!response.ok)
            throw new NaruDataError(
              response.status,
              `File upload failed (HTTP ${response.status}).`,
            );
          const finalized = await send(filePath(authorization.file.id), {
            method: "PUT",
            body: {},
            options: transferOptions,
            expect: EXPECT.file,
          });
          return finalized.file;
        } catch (cause) {
          let error = cause;
          try {
            scope.check();
          } catch (aborted) {
            error = aborted;
          }
          if (!(error instanceof NaruDataError)) {
            error = new NaruDataError(
              0,
              "File upload failed. Check your connection before retrying.",
            );
            error.cause = cause;
          }
          if (authorization) {
            error.fileId = authorization.file.id;
            // Cleanup gets its own bounded request, independent of cancellation.
            try {
              await send(filePath(error.fileId), {
                method: "DELETE",
                options: { timeoutMs: 10000 },
                expect: EXPECT.success,
              });
            } catch (cleanupError) {
              error.cleanupError = cleanupError;
            }
          }
          throw error;
        } finally {
          scope.close();
        }
      },
      async update(id, patch, { ifVersion, unset, ...options } = {}) {
        // Only the metadata is mutable: the bytes, their type and their size
        // were fixed when the upload was authorized and verified.
        const result = await send(`${filePath(id)}${condition(ifVersion)}`, {
          method: "PATCH",
          body: patchBody(patch, unset),
          options,
          expect: EXPECT.file,
        });
        return result.file;
      },
      delete(id, options) {
        return send(filePath(id), {
          method: "DELETE",
          options,
          expect: EXPECT.success,
        });
      },
    };
    return api;
  }
  // Each callback has an independent tab-scoped session. No localStorage or cookies.
  const callbackHref = () => window.location.origin + window.location.pathname;
  const sessionKey = () => `${storageKey}:session:${callbackHref()}`;
  // The transaction is keyed by the callback that will read it back, not by the
  // page that started it: two callbacks on one origin sign in independently.
  const pendingKey = (redirectUri) => `${storageKey}:pending:${redirectUri}`;
  const revoke = (token, options) =>
    request(`${base.origin}/api/data-auth/revoke`, {
      method: "POST",
      token,
      options,
    });
  let activeOwner = null;
  let completing = null;
  function ownerClient(saved, key) {
    let token = saved.accessToken;
    const expiresAt = saved.expiresAt;
    let status = "active";
    const listeners = new Set();
    const snapshot = () => Object.freeze({ status, expiresAt });
    const expire = () => {
      if (status === "active") clear("expired");
    };
    const expiryTimer = setTimeout(expire, Math.max(0, expiresAt - Date.now()));
    expiryTimer.unref?.();
    function clear(nextStatus = "signed-out") {
      const current = token;
      token = null;
      clearTimeout(expiryTimer);
      if (status !== nextStatus) {
        status = nextStatus;
        const session = snapshot();
        for (const listener of listeners) listener(session);
      }
      if (activeOwner === owner) activeOwner = null;
      // An older client must not erase a newer sign-in on the same page.
      try {
        const stored = window.sessionStorage.getItem(key);
        if (stored) {
          let parsed;
          try {
            parsed = JSON.parse(stored);
          } catch {
            // Malformed saved credentials cannot represent a newer login.
          }
          if (!parsed || parsed.accessToken === current)
            window.sessionStorage.removeItem(key);
        }
      } catch {
        // Storage may become unavailable after sign-in. Still revoke remotely
        // and invalidate this client instead of masking a 401 or blocking logout.
      }
    }
    const owner = {
      ...client(
        () => {
          if (!token || Date.now() >= expiresAt) {
            clear(Date.now() >= expiresAt ? "expired" : status);
            throw new NaruDataError(
              401,
              "Owner session expired or signed out. Sign in again.",
            );
          }
          return token;
        },
        () => clear("expired"),
        true,
      ),
      get session() {
        if (Date.now() >= expiresAt) expire();
        return snapshot();
      },
      onSessionChange(listener) {
        if (typeof listener !== "function")
          throw new TypeError("Session listener must be a function.");
        listeners.add(listener);
        listener(owner.session);
        return () => listeners.delete(listener);
      },
      async signOut(options) {
        const current = token;
        clear("signed-out");
        if (current) await revoke(current, options);
      },
    };
    return owner;
  }
  function restoreOwner() {
    if (activeOwner?.session.status === "active") return activeOwner;
    const key = sessionKey();
    let saved;
    try {
      saved = JSON.parse(window.sessionStorage.getItem(key));
    } catch {
      /* malformed */
    }
    if (
      !object(saved) ||
      !credentialsValue(saved.accessToken, saved.expiresAt) ||
      saved.redirectUri !== callbackHref()
    ) {
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        // Unavailable storage is not a usable owner session.
      }
      return null;
    }
    // Restoring never extends the deadline. The server checks authorization on every request.
    return (activeOwner = ownerClient(saved, key));
  }
  return {
    ...client(),
    async signInAsOwner({
      clientId,
      redirectUri = callbackHref(),
      collections,
      ...options
    }) {
      const scope = requestScope(options);
      try {
        scope.check();
        if (
          clientId !== undefined &&
          (typeof clientId !== "string" || !clientId || clientId.length > 64)
        )
          throw new TypeError(
            "clientId must be a non-empty string when provided.",
          );
        if (
          !Array.isArray(collections) ||
          !collections.length ||
          new Set(collections).size !== collections.length
        )
          throw new TypeError("Choose at least one unique collection.");
        collections.forEach(segment);
        const callback = new URL(redirectUri);
        if (
          callback.origin !== window.location.origin ||
          callback.search ||
          callback.hash ||
          callback.username ||
          callback.password
        )
          throw new TypeError(
            "Callback must be a registered URL on this origin without query or fragment.",
          );
        if (!clientId) {
          const discovery = new URL("/api/data-auth/discover", base.origin);
          discovery.search = new URLSearchParams({
            site,
            redirectUri: callback.href,
          }).toString();
          try {
            clientId = (
              await request(discovery.href, {
                options: { signal: scope.signal, timeoutMs: 0 },
              })
            ).clientId;
          } catch (error) {
            if (error instanceof NaruDataError && error.status === 404) {
              error.code = "UNREGISTERED_REDIRECT_URI";
              error.message = `Register ${callback.href} as an administrator callback in Naru.`;
            }
            throw error;
          }
          if (typeof clientId !== "string" || !clientId || clientId.length > 64)
            throw new NaruDataError(
              502,
              "Invalid owner client discovery response.",
              "INVALID_CLIENT_DISCOVERY",
            );
        }
        const verifier = random(),
          state = random();
        const challenge = base64url(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(verifier),
            ),
          ),
        );
        scope.check();
        // Persist the short-lived PKCE transaction across the approval redirect.
        window.sessionStorage.setItem(
          pendingKey(callback.href),
          JSON.stringify({
            clientId,
            redirectUri: callback.href,
            verifier,
            state,
            startedAt: Date.now(),
          }),
        );
        const url = new URL("/database/authorize", base.origin);
        url.search = new URLSearchParams({
          site,
          clientId,
          redirectUri: callback.href,
          challenge,
          state,
          collections: collections.join(","),
        }).toString();
        window.location.assign(url.href);
      } finally {
        scope.close();
      }
    },
    completeOwnerSignIn(options) {
      if (!completing)
        completing = complete(options).finally(() => {
          completing = null;
        });
      return completing;
    },
  };
  async function complete(options) {
    precheck(options);
    const url = new URL(window.location.href);
    if (!url.searchParams.has("code") && !url.searchParams.has("error"))
      return restoreOwner();
    const code = url.searchParams.get("code"),
      state = url.searchParams.get("state"),
      error = url.searchParams.get("error");
    for (const key of ["code", "state", "error"]) url.searchParams.delete(key);
    // Remove the authorization response before fetching or rendering user content.
    window.history.replaceState(window.history.state, "", url.href);
    const key = pendingKey(callbackHref());
    const saved = window.sessionStorage.getItem(key);
    window.sessionStorage.removeItem(key);
    let pending;
    try {
      pending = JSON.parse(saved);
    } catch {
      /* handled below */
    }
    if (
      !pending ||
      pending.state !== state ||
      pending.redirectUri !== callbackHref() ||
      !Number.isFinite(pending.startedAt) ||
      Date.now() - pending.startedAt > 10 * 60 * 1000 ||
      pending.startedAt > Date.now()
    ) {
      throw new NaruDataError(
        401,
        "Owner sign-in state is missing, invalid or expired. Sign in again.",
      );
    }
    if (error) throw new NaruDataError(403, "Owner sign-in was denied.");
    const result = await request(`${base.origin}/api/data-auth/token`, {
      method: "POST",
      body: {
        code,
        verifier: pending.verifier,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
      },
      options,
    });
    if (
      !credentialsValue(result.accessToken, result.expiresAt) ||
      result.tokenType !== "Bearer" ||
      !Number.isInteger(result.expiresIn) ||
      result.expiresIn <= 0 ||
      result.expiresIn > DAY_MS / 1000
    )
      throw new NaruDataError(502, "Invalid owner token response.");
    const credentials = {
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      redirectUri: pending.redirectUri,
    };
    const session = sessionKey();
    try {
      window.sessionStorage.setItem(session, JSON.stringify(credentials));
    } catch (error) {
      // If persistence fails, do not leave a newly issued token active unnecessarily.
      try {
        await revoke(result.accessToken);
      } catch {}
      throw error;
    }
    return (activeOwner = ownerClient(credentials, session));
  }
}
