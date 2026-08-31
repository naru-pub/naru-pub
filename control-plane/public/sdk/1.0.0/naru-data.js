/** Naru Data SDK 1.0.0. This release is still under active development. */
export class NaruDataError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "NaruDataError";
    this.status = status;
  }
}
const segment = (value) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value))
    throw new TypeError("Invalid collection or document ID.");
  return encodeURIComponent(value);
};
const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export const CONTROL_PLANE_ORIGIN = "https://naru.pub";
export function createDatabase({ site }) {
  if (typeof site !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(site))
    throw new TypeError("A valid Naru site login name is required.");
  const base = new URL(CONTROL_PLANE_ORIGIN);
  const root = `${base.origin}/api/data/${encodeURIComponent(site)}`;
  const storageKey = `naru:owner:${base.origin}:${site}`;
  async function request(url, method = "GET", body, token) {
    const response = await fetch(url, {
      method,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok)
      throw new NaruDataError(
        response.status,
        result.error || "Database request failed.",
      );
    return result;
  }
  function client(getToken = () => undefined, unauthorized = () => {}) {
    return {
      collection(collectionName) {
        const path = `${root}/${segment(collectionName)}`;
        const send = async (url, method, body) => {
          try {
            return await request(url, method, body, await getToken());
          } catch (error) {
            if (error.status === 401) unauthorized();
            throw error;
          }
        };
        return {
          async get(id) {
            return (await send(`${path}/${segment(id)}`)).document;
          },
          list({ limit = 50, after, orderBy, direction, where } = {}) {
            const query = new URLSearchParams({ limit: String(limit) });
            if (where !== undefined) {
              if (!where || typeof where !== "object" || Array.isArray(where))
                throw new TypeError(
                  "where must be an object of scalar equality filters.",
                );
              const entries = Object.entries(where);
              if (
                entries.length > 5 ||
                entries.some(
                  ([key, value]) =>
                    !/^[a-zA-Z0-9_-]{1,64}$/.test(key) ||
                    !(
                      value === null ||
                      typeof value === "string" ||
                      typeof value === "boolean" ||
                      (typeof value === "number" && Number.isFinite(value))
                    ),
                )
              )
                throw new TypeError(
                  "Use up to 5 top-level scalar equality filters.",
                );
              query.set("where", JSON.stringify(where));
            }
            if (orderBy !== undefined) query.set("orderBy", orderBy);
            if (direction !== undefined) query.set("direction", direction);
            if (after !== undefined) query.set("after", after);
            return send(`${path}?${query}`);
          },
          add(data) {
            return send(path, "POST", { data });
          },
          set(id, data) {
            return send(`${path}/${segment(id)}`, "PUT", { data });
          },
          delete(id) {
            return send(`${path}/${segment(id)}`, "DELETE");
          },
        };
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
      // An older client must not erase a newer sign-in on the same page.
      const stored = window.sessionStorage.getItem(key);
      if (stored) {
        try {
          if (JSON.parse(stored).accessToken === current)
            window.sessionStorage.removeItem(key);
        } catch {
          window.sessionStorage.removeItem(key);
        }
      }
      if (activeOwner === owner) activeOwner = null;
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
      window.sessionStorage.removeItem(key);
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
      if (typeof clientId !== "string" || !clientId || clientId.length > 64)
        throw new TypeError("Registered clientId required.");
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
