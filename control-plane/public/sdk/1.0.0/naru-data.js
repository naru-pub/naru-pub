/** Naru Data SDK 1.0.0. This release is still under active development. */

/** A request the data API answered with an error. */
export class NaruDataError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "NaruDataError";
    this.status = status;
    this.code =
      code || (status === 401 ? "OWNER_SESSION_EXPIRED" : "REQUEST_FAILED");
  }
}

const CONTROL_PLANE = "https://naru.pub";
const SITE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
// A public read may be answered by a shared cache for this long after a write.
const PUBLIC_CACHE_MS = 10_000;

// Where requests go. A page on alice.naru.pub belongs to the site alice, so
// only custom domains and local development need to say which site they are.
// controlPlaneOrigin is for Naru's own tests against a loopback server.
function target({ site, controlPlaneOrigin = CONTROL_PLANE } = {}) {
  site ??= /^([a-z0-9-]+)\.naru\.pub$/.exec(
    globalThis.location?.hostname ?? "",
  )?.[1];
  if (typeof site !== "string" || !SITE.test(site))
    throw new TypeError(
      "Pass { site: <Naru login name> } when the page is not on <site>.naru.pub.",
    );
  const origin = new URL(controlPlaneOrigin);
  const loopback =
    origin.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.origin !== CONTROL_PLANE && !loopback)
    throw new TypeError(
      "controlPlaneOrigin must be https://naru.pub or an HTTP loopback origin.",
    );
  return {
    site,
    origin: origin.origin,
    root: `${origin.origin}/api/data/${site}`,
  };
}

// A document ID becomes a path segment. Checking it here keeps "..", which a
// URL would resolve away, from ever addressing something else.
function segment(value) {
  if (typeof value !== "string" || !ID.test(value))
    throw new TypeError(
      "Names and IDs are 1-64 ASCII letters, digits, underscores or hyphens.",
    );
  return value;
}

// Collections this browser wrote recently, so reading them skips the shared
// cache and shows the write. Keyed by collection URL, which names the site.
const writtenUntil = new Map();

async function request(url, { method = "GET", body, token, signal, touches }) {
  const fresh =
    token ||
    method !== "GET" ||
    touches.some((path) => (writtenUntil.get(path) ?? 0) > Date.now());
  let response;
  try {
    response = await fetch(url, {
      method,
      signal,
      credentials: "omit",
      redirect: "error",
      cache: fresh ? "no-store" : "default",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } finally {
    // Also when the response was lost: the write may still have landed.
    if (method !== "GET")
      for (const path of touches)
        writtenUntil.set(path, Date.now() + PUBLIC_CACHE_MS);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new NaruDataError(
      response.status,
      result.error ?? `Database request failed (HTTP ${response.status}).`,
      result.code,
    );
  return result;
}

function query({ where, orderBy, limit, pageToken, includeTotal } = {}) {
  const parameters = new URLSearchParams();
  if (where && Object.keys(where).length)
    parameters.set("where", JSON.stringify(where));
  if (orderBy) parameters.set("orderBy", JSON.stringify(orderBy));
  if (limit !== undefined) parameters.set("limit", String(limit));
  if (pageToken) parameters.set("pageToken", pageToken);
  if (includeTotal) parameters.set("includeTotal", "1");
  const text = String(parameters);
  return text ? `?${text}` : "";
}

const version = (ifVersion) =>
  ifVersion === undefined ? "" : `?ifVersion=${ifVersion}`;

function documents(root, name, send) {
  const path = `${root}/${segment(name)}`;
  const touches = [path];
  return Object.freeze({
    async get(id, { signal } = {}) {
      const result = await send(`${path}/${segment(id)}`, { signal, touches });
      return result.document;
    },
    list(options = {}) {
      return send(`${path}${query(options)}`, {
        signal: options.signal,
        touches,
      });
    },
    add(data, { signal } = {}) {
      return send(path, { method: "POST", body: { data }, signal, touches });
    },
    set(id, data, { ifVersion, signal } = {}) {
      return send(`${path}/${segment(id)}${version(ifVersion)}`, {
        method: "PUT",
        body: { data },
        signal,
        touches,
      });
    },
    async delete(id, { ifVersion, signal } = {}) {
      await send(`${path}/${segment(id)}${version(ifVersion)}`, {
        method: "DELETE",
        signal,
        touches,
      });
    },
  });
}

/** A collection of the site this page belongs to. Nothing is requested yet. */
export function collection(name, options) {
  return documents(target(options).root, name, request);
}

// Photos straight off a phone are several megabytes and thousands of pixels
// for an image a page shows at a fraction of that. Uploads go straight to
// object storage, so the browser is the only place to shrink them: before the
// upload is authorized, so quota counts what is stored, and by re-encoding,
// which drops EXIF so a photo's location never reaches the public URL.
const MAX_EDGE = 2048;
const SMALL_BYTES = 512 * 1024;
async function shrink(file) {
  const heic = /^image\/hei[cf]$/.test(file.type);
  if (
    !(heic || /^image\/(jpeg|png|webp)$/.test(file.type)) ||
    typeof createImageBitmap !== "function"
  )
    return file;
  let bitmap;
  try {
    // Canvas discards EXIF, so orientation is baked into the pixels here.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && !heic && file.size <= SMALL_BYTES) return file;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    for (const type of ["image/webp", "image/jpeg"]) {
      const canvas =
        typeof OffscreenCanvas === "function"
          ? new OffscreenCanvas(width, height)
          : Object.assign(document.createElement("canvas"), { width, height });
      const context = canvas.getContext("2d");
      // JPEG has no transparency; paint white rather than let it go black.
      if (type === "image/jpeg") {
        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await (canvas.convertToBlob
        ? canvas.convertToBlob({ type, quality: 0.82 })
        : new Promise((resolve) => canvas.toBlob(resolve, type, 0.82)));
      // A browser that cannot encode a type quietly returns PNG instead.
      if (blob?.type !== type) continue;
      // HEIC is not accepted as is, so its conversion is kept even if larger.
      if (!heic && blob.size >= file.size) return file;
      const base = (file.name || "upload").replace(/\.[^.]*$/, "");
      return new File([blob], `${base}.${type.slice(6)}`, { type });
    }
    return file;
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}

// Each callback page keeps its own session in its own tab.
const sessionKey = ({ origin, site }) =>
  `naru:owner:${origin}:${site}:${location.origin}${location.pathname}`;

// An older client must not erase a newer sign-in made on the same page.
function forget(key, token) {
  try {
    if (JSON.parse(sessionStorage.getItem(key))?.accessToken !== token) return;
  } catch {
    /* unreadable, so not a newer sign-in */
  }
  sessionStorage.removeItem(key);
}

function owner(context, token, expiresAt) {
  const { origin, root } = context;
  const key = sessionKey(context);
  const send = async (url, init) => {
    if (Date.now() >= expiresAt) {
      forget(key, token);
      throw new NaruDataError(401, "Owner session expired. Sign in again.");
    }
    try {
      return await request(url, { ...init, token });
    } catch (error) {
      if (error.status === 401) forget(key, token);
      throw error;
    }
  };
  return Object.freeze({
    /** Unix milliseconds after which requests fail and sign-in is needed. */
    expiresAt,
    collection: (name) => documents(root, name, send),
    async batch(operations, { signal } = {}) {
      const touches = [
        ...new Set(operations.map((item) => `${root}/${item.collection}`)),
      ];
      const result = await send(`${root}/_batch`, {
        method: "POST",
        body: { operations },
        signal,
        touches,
      });
      return result.results;
    },
    files: Object.freeze({
      list(options = {}) {
        return send(`${root}/_files${query(options)}`, {
          signal: options.signal,
          touches: [],
        });
      },
      async upload(source, { signal } = {}) {
        const file = await shrink(source);
        const authorization = await send(`${root}/_files`, {
          method: "POST",
          body: {
            name: file.name || "upload",
            contentType: file.type,
            size: file.size,
          },
          signal,
          touches: [],
        });
        const upload = await fetch(authorization.uploadUrl, {
          method: "PUT",
          headers: authorization.headers,
          body: file,
          signal,
          credentials: "omit",
          redirect: "error",
        });
        // An upload that never finishes is removed by the server within an hour.
        if (!upload.ok)
          throw new NaruDataError(
            upload.status,
            `File upload failed (HTTP ${upload.status}).`,
          );
        const finished = await send(
          `${root}/_files/${segment(authorization.id)}`,
          { method: "PUT", body: {}, signal, touches: [] },
        );
        return finished.file;
      },
      async delete(id, { signal } = {}) {
        await send(`${root}/_files/${segment(id)}`, {
          method: "DELETE",
          signal,
          touches: [],
        });
      },
    }),
    /** Forgets the session here first, then asks Naru to revoke it. */
    async signOut() {
      forget(key, token);
      await request(`${origin}/api/data-auth/revoke`, {
        method: "POST",
        token,
        touches: [],
      });
    },
  });
}

const base64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const callback = () => location.origin + location.pathname;

/**
 * Leaves for Naru, where the owner approves access to `collections`, and comes
 * back to this page. Register this page's URL as an administrator callback in
 * the control panel first.
 */
export async function signIn({ collections, ...options }) {
  const context = target(options);
  const { site, origin } = context;
  const discovery = new URL("/api/data-auth/discover", origin);
  discovery.search = String(
    new URLSearchParams({ site, redirectUri: callback() }),
  );
  const { clientId } = await request(discovery.href, { touches: [] });
  const verifier = random();
  const state = random();
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  // The PKCE transaction has to survive the round trip through Naru.
  sessionStorage.setItem(
    `${sessionKey(context)}:pending`,
    JSON.stringify({ clientId, verifier, state, startedAt: Date.now() }),
  );
  const approval = new URL("/database/authorize", origin);
  approval.search = String(
    new URLSearchParams({
      site,
      clientId,
      redirectUri: callback(),
      challenge,
      state,
      collections: collections.join(","),
    }),
  );
  location.assign(approval.href);
}

/**
 * The signed-in owner client for this page, or null. Finishes a sign-in when
 * Naru has just redirected back, and otherwise restores this tab's session.
 * Call it before rendering: it removes the one-time code from the address bar.
 */
export async function ownerSession(options) {
  const context = target(options);
  const key = sessionKey(context);
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const denied = url.searchParams.get("error");
  if (code === null && denied === null) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key));
      if (saved?.expiresAt > Date.now())
        return owner(context, saved.accessToken, saved.expiresAt);
    } catch {
      /* no usable session */
    }
    sessionStorage.removeItem(key);
    return null;
  }
  const state = url.searchParams.get("state");
  for (const name of ["code", "state", "error"]) url.searchParams.delete(name);
  history.replaceState(history.state, "", url.href);
  let pending;
  try {
    pending = JSON.parse(sessionStorage.getItem(`${key}:pending`));
  } catch {
    /* treated as missing */
  }
  sessionStorage.removeItem(`${key}:pending`);
  if (
    !pending ||
    pending.state !== state ||
    !(Date.now() - pending.startedAt < 10 * 60 * 1000)
  )
    throw new NaruDataError(401, "Sign-in expired or did not start here.");
  if (denied !== null) throw new NaruDataError(403, "Sign-in was denied.");
  const token = await request(`${context.origin}/api/data-auth/token`, {
    method: "POST",
    body: {
      code,
      verifier: pending.verifier,
      clientId: pending.clientId,
      redirectUri: callback(),
    },
    touches: [],
  });
  sessionStorage.setItem(
    key,
    JSON.stringify({
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
    }),
  );
  return owner(context, token.accessToken, token.expiresAt);
}
