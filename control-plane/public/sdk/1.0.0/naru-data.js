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
const segment = (value) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value))
    throw new TypeError("Invalid collection or document ID.");
  return encodeURIComponent(value);
};
const FIELD = /^[a-zA-Z0-9_-]{1,64}$/;
const COMPARISONS = ["gt", "gte", "lt", "lte"];
const isScalar = (value) =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));
// Mirrors the server's rules so mistakes surface before a round trip. The
// server revalidates; this never widens what the server will accept.
function filterJson(where) {
  if (!where || typeof where !== "object" || Array.isArray(where))
    throw new TypeError("where must be an object of filters.");
  let predicates = 0;
  for (const [field, value] of Object.entries(where)) {
    if (!FIELD.test(field))
      throw new TypeError(`Invalid filter field ${field}.`);
    if (isScalar(value)) {
      predicates += 1;
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new TypeError(
        "Filter values must be scalars or a comparison object.",
      );
    const bounds = Object.entries(value);
    if (!bounds.length)
      throw new TypeError("Comparison objects need at least one operator.");
    for (const [operator, bound] of bounds) {
      if (!COMPARISONS.includes(operator))
        throw new TypeError("Use gt, gte, lt or lte for range comparisons.");
      if (
        !(
          typeof bound === "string" ||
          (typeof bound === "number" && Number.isFinite(bound))
        )
      )
        throw new TypeError("Range bounds must be strings or finite numbers.");
      if (typeof bound !== typeof bounds[0][1])
        throw new TypeError("Range bounds on one field must share a type.");
      predicates += 1;
    }
  }
  if (predicates > 5) throw new TypeError("Use at most 5 filter predicates.");
  return JSON.stringify(where);
}
const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export const CONTROL_PLANE_ORIGIN = "https://naru.pub";
export function createDatabase({
  site,
  controlPlaneOrigin = CONTROL_PLANE_ORIGIN,
  schemas = {},
}) {
  if (typeof site !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(site))
    throw new TypeError("A valid Naru site login name is required.");
  const base = new URL(controlPlaneOrigin);
  if (
    base.origin !== CONTROL_PLANE_ORIGIN &&
    !(
      base.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
    )
  )
    throw new TypeError(
      "controlPlaneOrigin must be https://naru.pub or an HTTP loopback origin.",
    );
  const root = `${base.origin}/api/data/${encodeURIComponent(site)}`;
  const storageKey = `naru:owner:${base.origin}:${site}`;
  if (!schemas || typeof schemas !== "object" || Array.isArray(schemas))
    throw new TypeError("schemas must be an object of validator functions.");
  function validateDocument(collectionName, data) {
    validateJson(data);
    const validator = schemas[collectionName];
    if (validator === undefined) return;
    if (typeof validator !== "function")
      throw new TypeError(`Schema for ${collectionName} must be a function.`);
    if (validator(data) === false)
      throw new TypeError(
        `Document does not match the ${collectionName} schema.`,
      );
  }
  async function request(url, method = "GET", body, token) {
    // Serialize before awaiting so later caller mutations cannot change the write.
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    let response;
    try {
      response = await fetch(url, {
        method,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: serialized,
      });
    } catch (cause) {
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
      const error = new NaruDataError(
        response.status,
        response.ok
          ? "Invalid JSON response from the database."
          : `Database request failed (HTTP ${response.status}).`,
      );
      error.cause = cause;
      throw error;
    }
    if (!response.ok)
      throw new NaruDataError(
        response.status,
        typeof result?.error === "string"
          ? result.error
          : `Database request failed (HTTP ${response.status}).`,
        typeof result?.code === "string" ? result.code : undefined,
      );
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new NaruDataError(
        response.status,
        "Invalid response from the database.",
      );
    return result;
  }
  function client(getToken = () => undefined, unauthorized = () => {}) {
    const send = async (url, method, body) => {
      try {
        return await request(url, method, body, getToken());
      } catch (error) {
        if (error.status === 401) unauthorized();
        throw error;
      }
    };
    return {
      batch(operations) {
        if (
          !Array.isArray(operations) ||
          !operations.length ||
          operations.length > 100
        )
          throw new TypeError("Batch requires 1–100 operations.");
        const snapshot = operations.map((operation) => {
          if (
            !operation ||
            typeof operation !== "object" ||
            Array.isArray(operation)
          )
            throw new TypeError("Invalid batch operation.");
          const collection = operation.collection;
          segment(collection);
          segment(operation.id);
          if (operation.type === "set")
            validateDocument(collection, operation.data);
          else if (operation.type !== "delete")
            throw new TypeError("Batch operations must be set or delete.");
          return operation.type === "set"
            ? {
                type: "set",
                collection,
                id: operation.id,
                data: operation.data,
              }
            : { type: "delete", collection, id: operation.id };
        });
        return send(`${root}/_batch`, "POST", { operations: snapshot });
      },
      collection(collectionName) {
        const path = `${root}/${segment(collectionName)}`;
        const query = ({ where, orderBy, direction }) => {
          const parameters = new URLSearchParams();
          if (where !== undefined) parameters.set("where", filterJson(where));
          if (orderBy !== undefined) parameters.set("orderBy", orderBy);
          if (direction !== undefined) parameters.set("direction", direction);
          return parameters;
        };
        const list = (options = {}) => {
          const parameters = query(options);
          parameters.set("limit", String(options.limit ?? 50));
          if (options.after !== undefined)
            parameters.set("after", options.after);
          return send(`${path}?${parameters}`);
        };
        return {
          async get(id) {
            return (await send(`${path}/${segment(id)}`)).document;
          },
          list,
          async count(options = {}) {
            const parameters = query(options);
            parameters.set("count", "1");
            return (await send(`${path}?${parameters}`)).count;
          },
          async *all(options = {}) {
            let after;
            do {
              const page = await list({ limit: 100, ...options, after });
              yield* page.documents;
              // A repeated cursor would page forever; stop instead.
              if (page.nextCursor === after) return;
              after = page.nextCursor ?? undefined;
            } while (after);
          },
          add(data) {
            validateDocument(collectionName, data);
            return send(path, "POST", { data });
          },
          set(id, data) {
            validateDocument(collectionName, data);
            return send(`${path}/${segment(id)}`, "PUT", { data });
          },
          delete(id) {
            return send(`${path}/${segment(id)}`, "DELETE");
          },
        };
      },
      files: {
        async get(id) {
          return (await send(`${root}/_files/${segment(id)}`)).file;
        },
        async list() {
          return (await send(`${root}/_files`)).files;
        },
        async usage() {
          return (await send(`${root}/_files`)).usage;
        },
        async upload(file, { onProgress, signal, metadata = {} } = {}) {
          if (!(file instanceof Blob))
            throw new TypeError("upload requires a File or Blob.");
          if (onProgress !== undefined && typeof onProgress !== "function")
            throw new TypeError("onProgress must be a function.");
          if (signal?.aborted)
            throw (
              signal.reason || new DOMException("Upload aborted.", "AbortError")
            );
          validateJson(metadata);
          if (!file.size || file.size > 25 * 1024 * 1024)
            throw new TypeError("File must be between 1 byte and 25 MiB.");
          const name =
            typeof file.name === "string" && file.name ? file.name : "upload";
          const contentType = file.type || "application/octet-stream";
          const authorization = await send(`${root}/_files`, "POST", {
            name,
            contentType,
            size: file.size,
            metadata,
          });
          let response;
          try {
            if (onProgress && typeof XMLHttpRequest !== "undefined") {
              response = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open(authorization.method, authorization.uploadUrl);
                for (const [key, value] of Object.entries(
                  authorization.headers,
                ))
                  xhr.setRequestHeader(key, value);
                xhr.upload.onprogress = (event) =>
                  onProgress({
                    loaded: event.loaded,
                    total: event.lengthComputable ? event.total : file.size,
                  });
                xhr.onload = () =>
                  resolve({
                    ok: xhr.status >= 200 && xhr.status < 300,
                    status: xhr.status,
                  });
                xhr.onerror = () =>
                  reject(new TypeError("Network request failed."));
                xhr.onabort = () =>
                  reject(
                    signal?.reason ||
                      new DOMException("Upload aborted.", "AbortError"),
                  );
                signal?.addEventListener("abort", () => xhr.abort(), {
                  once: true,
                });
                xhr.send(file);
              });
            } else {
              response = await fetch(authorization.uploadUrl, {
                method: authorization.method,
                headers: authorization.headers,
                body: file,
                signal,
              });
            }
          } catch (cause) {
            send(
              `${root}/_files/${segment(authorization.file.id)}`,
              "DELETE",
            ).catch(() => {});
            const error = new NaruDataError(
              0,
              "File upload failed. Check your connection before retrying.",
            );
            error.cause = cause;
            throw error;
          }
          if (!response.ok) {
            send(
              `${root}/_files/${segment(authorization.file.id)}`,
              "DELETE",
            ).catch(() => {});
            throw new NaruDataError(
              response.status,
              `File upload failed (HTTP ${response.status}).`,
            );
          }
          return (
            await send(
              `${root}/_files/${segment(authorization.file.id)}`,
              "PUT",
              {},
            )
          ).file;
        },
        delete(id) {
          return send(`${root}/_files/${segment(id)}`, "DELETE");
        },
      },
    };
  }
  // Each callback has an independent tab-scoped session. No localStorage or cookies.
  const sessionKey = () =>
    `${storageKey}:session:${window.location.origin}${window.location.pathname}`;
  let activeOwner = null;
  let completing = null;
  function ownerClient(saved, key) {
    let token = saved.accessToken;
    const expiresAt = saved.expiresAt;
    function clear() {
      const current = token;
      token = null;
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
      ...client(() => {
        if (!token || Date.now() >= expiresAt) {
          clear();
          throw new NaruDataError(
            401,
            "Owner session expired or signed out. Sign in again.",
          );
        }
        return token;
      }, clear),
      expiresAt,
      async signOut() {
        const current = token;
        clear();
        if (current)
          await request(
            `${base.origin}/api/data-auth/revoke`,
            "POST",
            undefined,
            current,
          );
      },
    };
    return owner;
  }
  function restoreOwner() {
    if (activeOwner && activeOwner.expiresAt > Date.now()) return activeOwner;
    activeOwner = null;
    const key = sessionKey();
    let saved;
    try {
      saved = JSON.parse(window.sessionStorage.getItem(key));
    } catch {
      /* malformed */
    }
    if (
      !saved ||
      !/^[A-Za-z0-9_-]{43}$/.test(saved.accessToken) ||
      saved.redirectUri !== window.location.origin + window.location.pathname ||
      !Number.isFinite(saved.expiresAt) ||
      saved.expiresAt <= Date.now() ||
      saved.expiresAt > Date.now() + 24 * 60 * 60 * 1000 + 60000
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
      redirectUri = window.location.origin + window.location.pathname,
      collections,
    }) {
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
        collections.length > 100 ||
        new Set(collections).size !== collections.length
      )
        throw new TypeError("Choose 1–100 unique collections.");
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
          clientId = (await request(discovery.href)).clientId;
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
      // Persist the short-lived PKCE transaction across the approval redirect.
      window.sessionStorage.setItem(
        storageKey,
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
    },
    completeOwnerSignIn() {
      if (!completing)
        completing = complete().finally(() => {
          completing = null;
        });
      return completing;
    },
  };
  async function complete() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("code") && !url.searchParams.has("error"))
      return restoreOwner();
    const code = url.searchParams.get("code"),
      state = url.searchParams.get("state"),
      error = url.searchParams.get("error");
    for (const key of ["code", "state", "error"]) url.searchParams.delete(key);
    // Remove the authorization response before fetching or rendering user content.
    window.history.replaceState(null, "", url.href);
    const saved = window.sessionStorage.getItem(storageKey);
    window.sessionStorage.removeItem(storageKey);
    let pending;
    try {
      pending = JSON.parse(saved);
    } catch {
      /* handled below */
    }
    if (
      !pending ||
      pending.state !== state ||
      pending.redirectUri !== url.href ||
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
    const result = await request(`${base.origin}/api/data-auth/token`, "POST", {
      code,
      verifier: pending.verifier,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
    });
    if (
      !result ||
      !/^[A-Za-z0-9_-]{43}$/.test(result.accessToken) ||
      result.tokenType !== "Bearer" ||
      !Number.isInteger(result.expiresIn) ||
      result.expiresIn <= 0 ||
      result.expiresIn > 24 * 60 * 60 ||
      !Number.isFinite(result.expiresAt) ||
      result.expiresAt <= Date.now() ||
      result.expiresAt > Date.now() + 24 * 60 * 60 * 1000 + 60000
    )
      throw new NaruDataError(502, "Invalid owner token response.");
    const credentials = {
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      redirectUri: pending.redirectUri,
    };
    const key = sessionKey();
    try {
      window.sessionStorage.setItem(key, JSON.stringify(credentials));
    } catch (error) {
      // If persistence fails, do not leave a newly issued token active unnecessarily.
      try {
        await request(
          `${base.origin}/api/data-auth/revoke`,
          "POST",
          undefined,
          result.accessToken,
        );
      } catch {}
      throw error;
    }
    return (activeOwner = ownerClient(credentials, key));
  }
}
