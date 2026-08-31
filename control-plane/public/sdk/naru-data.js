/** Naru Data browser SDK v1. Public calls never send login credentials. */
export class NaruDataError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "NaruDataError";
    this.status = status;
  }
}

export function createDatabase({
  site,
  baseUrl = new URL(import.meta.url).origin,
}) {
  if (typeof site !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(site)) {
    throw new TypeError("A valid Naru site login name is required.");
  }
  const root = `${baseUrl.replace(/\/$/, "")}/api/data/${encodeURIComponent(site)}`;
  const segment = (value) => {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value))
      throw new TypeError("Invalid collection or document ID.");
    return encodeURIComponent(value);
  };
  async function request(path, method = "GET", body) {
    const response = await fetch(`${root}/${path}`, {
      method,
      credentials: "omit",
      cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
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
  return {
    collection(collectionName) {
      const path = segment(collectionName);
      return {
        async get(id) {
          return (await request(`${path}/${segment(id)}`)).document;
        },
        list({ limit = 50, after } = {}) {
          const query = new URLSearchParams({ limit: String(limit) });
          if (after !== undefined) query.set("after", after);
          return request(`${path}?${query}`);
        },
        add(data) {
          return request(path, "POST", { data });
        },
        set(id, data) {
          return request(`${path}/${segment(id)}`, "PUT", { data });
        },
        delete(id) {
          return request(`${path}/${segment(id)}`, "DELETE");
        },
      };
    },
  };
}
