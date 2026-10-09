/** @jest-environment node */
import { beforeEach, expect, jest, test } from "@jest/globals";
jest.mock("../service", () => ({ executeData: jest.fn() }));
// Every site on PostgreSQL, without asking a database which store it is on.
jest.mock("../backend", () => ({
  siteDataBackend: async () => ({
    execute: (command: unknown) =>
      (require("../service") as typeof import("../service")).executeData(
        command as never,
      ),
  }),
}));
jest.mock("@/lib/auth", () => ({ validateRequest: jest.fn() }));
const { dataRequest } = require("../http") as typeof import("../http");
const execute = jest.mocked(
  (require("../service") as typeof import("../service")).executeData,
);
const auth = jest.mocked(
  (require("@/lib/auth") as typeof import("@/lib/auth")).validateRequest,
);
beforeEach(() => {
  jest.resetAllMocks();
  execute.mockResolvedValue({
    id: "one",
    data: { title: "saved" },
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
});

test("public requests ignore even valid owner cookies", async () => {
  const response = await dataRequest(
    new Request("https://naru.pub/api/data/v1/alice/posts", {
      headers: {
        Cookie: "auth_session=owner",
        Origin: "https://alice.naru.pub",
      },
    }),
    ["posts"],
    "alice",
  );
  expect(response.status).toBe(200);
  expect(auth).not.toHaveBeenCalled();
  expect(execute.mock.calls[0][0].adminUserId).toBeUndefined();
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ id: "one", revision: "r1.1" });
});

test("public conditional writes decode opaque revisions at the server boundary", async () => {
  await dataRequest(
    new Request(
      "https://naru.pub/api/data/v1/alice/posts/one?ifRevision=r1.a",
      {
        method: "DELETE",
      },
    ),
    ["posts", "one"],
    "alice",
  );
  expect(execute.mock.calls[0][0].ifVersion).toBe(10);
});
test.each(["https://alice.naru.pub", "https://evil.test", "null", null])(
  "admin writes reject origin %s before auth",
  async (origin) => {
    const response = await dataRequest(
      new Request("https://naru.pub/api/account/database/posts", {
        method: "DELETE",
        headers: origin ? { Origin: origin } : {},
      }),
      ["posts"],
    );
    expect(response.status).toBe(403);
    expect(auth).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  },
);
test("unauthenticated admin requests are denied", async () => {
  auth.mockResolvedValue({ user: null, session: null });
  const response = await dataRequest(
    new Request("https://naru.pub/api/account/database"),
    [],
  );
  expect(response.status).toBe(401);
  expect(execute).not.toHaveBeenCalled();
});
test("preflight needs no authentication and performs no database work", async () => {
  const response = await dataRequest(
    new Request("https://naru.pub/api/data/v1/alice/posts", {
      method: "OPTIONS",
    }),
    ["posts"],
    "alice",
  );
  expect(response.status).toBe(204);
  expect(auth).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

test("website bearer is passed with origin without consulting owner cookies", async () => {
  const token = "t".repeat(43);
  const response = await dataRequest(
    new Request("https://naru.pub/api/data/v1/alice/posts", {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://alice.example",
        Cookie: "auth_session=owner",
      },
    }),
    ["posts"],
    "alice",
  );
  expect(response.status).toBe(200);
  expect(auth).not.toHaveBeenCalled();
  expect(execute.mock.calls[0][0].bearer).toEqual({
    token,
    origin: "https://alice.example",
  });
  expect(response.headers.get("access-control-allow-origin")).toBe(
    "https://alice.example",
  );
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
});
test("a renewed owner token is reported as an instant and as seconds from now", async () => {
  const expiresAt = Date.now() + 3600000;
  execute.mockImplementationOnce(async (command) => {
    command.bearer!.expiresAt = expiresAt;
    return { success: true } as never;
  });
  const response = await dataRequest(
    new Request("https://naru.pub/api/data/v1/alice/posts", {
      headers: {
        Authorization: `Bearer ${"t".repeat(43)}`,
        Origin: "https://alice.example",
      },
    }),
    ["posts"],
    "alice",
  );
  expect(response.headers.get("naru-owner-expires")).toBe(String(expiresAt));
  const seconds = Number(response.headers.get("naru-owner-expires-in"));
  expect(seconds).toBeGreaterThanOrEqual(3598);
  expect(seconds).toBeLessThanOrEqual(3600);
  expect(
    response.headers.get("access-control-expose-headers")?.split(/,\s*/),
  ).toEqual(["Naru-Owner-Expires", "Naru-Owner-Expires-In"]);
});

test.each(["", "Basic abc", "Bearer malformed"])(
  "invalid authorization never falls back to public access: %s",
  async (authorization) => {
    const response = await dataRequest(
      new Request("https://naru.pub/api/data/v1/alice/posts", {
        headers: { Authorization: authorization },
      }),
      ["posts"],
      "alice",
    );
    expect(response.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  },
);
test("untrusted IP headers do not select a separate rate limit bucket", async () => {
  const previous = process.env.SITE_DATA_TRUST_CLOUDFLARE_IP;
  delete process.env.SITE_DATA_TRUST_CLOUDFLARE_IP;
  try {
    await dataRequest(
      new Request("https://naru.pub/api/data/v1/alice/posts", {
        headers: { "cf-connecting-ip": "192.0.2.99" },
      }),
      ["posts"],
      "alice",
    );
    expect(execute.mock.calls[0][0].clientIp).toBeUndefined();
  } finally {
    if (previous === undefined)
      delete process.env.SITE_DATA_TRUST_CLOUDFLARE_IP;
    else process.env.SITE_DATA_TRUST_CLOUDFLARE_IP = previous;
  }
});

test("trusted ingress IP selects the public-write rate limit bucket", async () => {
  const previous = process.env.SITE_DATA_TRUST_CLOUDFLARE_IP;
  process.env.SITE_DATA_TRUST_CLOUDFLARE_IP = "1";
  try {
    await dataRequest(
      new Request("https://naru.pub/api/data/v1/alice/posts", {
        headers: { "cf-connecting-ip": "2001:db8::99" },
      }),
      ["posts"],
      "alice",
    );
    expect(execute.mock.calls[0][0].clientIp).toBe("2001:db8::99");
  } finally {
    if (previous === undefined)
      delete process.env.SITE_DATA_TRUST_CLOUDFLARE_IP;
    else process.env.SITE_DATA_TRUST_CLOUDFLARE_IP = previous;
  }
});

test("canonical control-plane origin works behind a proxy without trusting forwarded host", async () => {
  const { sameOrigin } = await import("../validation");
  const previous = process.env.SITE_DATA_CONTROL_PLANE_ORIGIN;
  process.env.SITE_DATA_CONTROL_PLANE_ORIGIN = "https://naru.pub";
  try {
    expect(() =>
      sameOrigin(
        new Request("http://localhost:3000/api/data-auth/authorize", {
          method: "POST",
          headers: { Origin: "https://naru.pub" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      sameOrigin(
        new Request("http://localhost:3000/api/data-auth/authorize", {
          method: "POST",
          headers: {
            Origin: "https://evil.example",
            "x-forwarded-host": "evil.example",
          },
        }),
      ),
    ).toThrow();
  } finally {
    if (previous === undefined)
      delete process.env.SITE_DATA_CONTROL_PLANE_ORIGIN;
    else process.env.SITE_DATA_CONTROL_PLANE_ORIGIN = previous;
  }
});

test("list sort, cursor and page size are passed through for both API surfaces", async () => {
  auth.mockResolvedValue({
    user: { id: 1, loginName: "alice" },
    session: {},
  } as never);
  for (const site of ["alice", undefined]) {
    await dataRequest(
      new Request(
        `https://naru.pub/api/data/v1/alice/posts?sort=${encodeURIComponent('[[{"metadata":"createdAt"},"desc"]]')}&after=v1.example&size=7`,
      ),
      ["posts"],
      site,
    );
    expect(execute.mock.lastCall![0]).toMatchObject({
      sort: '[[{"metadata":"createdAt"},"desc"]]',
      after: "v1.example",
      size: 7,
    });
    expect(execute.mock.lastCall![0]).not.toHaveProperty("direction");
  }
});

test("filter query JSON is decoded and bounded", async () => {
  const filter = { postId: "한글", approved: false };
  const res = await dataRequest(
    new Request(
      `https://naru.pub/api/data/v1/alice/posts?filter=${encodeURIComponent(JSON.stringify(filter))}`,
    ),
    ["posts"],
    "alice",
  );
  expect(res.status).toBe(200);
  expect(execute.mock.lastCall![0].filter).toEqual(filter);
  for (const raw of ["{", " ".repeat(2049)]) {
    expect(
      (
        await dataRequest(
          new Request(
            `https://naru.pub/api/data/v1/alice/posts?filter=${encodeURIComponent(raw)}`,
          ),
          ["posts"],
          "alice",
        )
      ).status,
    ).toBe(400);
  }
});

test("website errors carry a protocol code; the control panel keeps a message", async () => {
  const { DataError } = await import("../validation");
  const fail = async (error: unknown, site?: string) => {
    execute.mockRejectedValueOnce(error as never);
    const response = await dataRequest(
      new Request("https://naru.pub/api/data/v1/alice/posts", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(site ? {} : { Origin: "https://naru.pub" }),
        },
        body: '{"data":1}',
      }),
      ["posts", "one"],
      site,
    );
    return { status: response.status, body: await response.json() };
  };
  // The same status means different things; the code tells them apart.
  expect(
    await fail(new DataError(409, "Full.", "QUOTA_EXCEEDED"), "alice"),
  ).toEqual({
    status: 409,
    body: { error: { code: "QUOTA_EXCEEDED", message: "Full." } },
  });
  expect(
    await fail(new DataError(409, "Stale.", "CONFLICT"), "alice"),
  ).toMatchObject({ body: { error: { code: "CONFLICT" } } });
  // Without one, the status names it.
  for (const [status, code] of [
    [400, "INVALID_REQUEST"],
    [401, "AUTH_REQUIRED"],
    [403, "ACCESS_DENIED"],
    [404, "NOT_FOUND"],
    [413, "INVALID_REQUEST"],
    [429, "RATE_LIMITED"],
  ] as const)
    expect(await fail(new DataError(status, "Failed."), "alice")).toMatchObject(
      { status, body: { error: { code } } },
    );
  const unexpected = jest.spyOn(console, "error").mockImplementation(() => {});
  expect(await fail(new Error("boom"), "alice")).toEqual({
    status: 500,
    body: {
      error: { code: "UNAVAILABLE", message: "Database request failed." },
    },
  });
  unexpected.mockRestore();
  auth.mockResolvedValue({
    user: { id: 1, loginName: "alice" },
    session: {},
  } as never);
  expect(await fail(new DataError(409, "Full.", "QUOTA_EXCEEDED"))).toEqual({
    status: 409,
    body: { error: "Full." },
  });
});

test("SDK freshness reads stay uncached independently of the shared cache lifetime", async () => {
  execute.mockImplementation(async (command) => {
    command.cacheability!.public = true;
    return { documents: [], nextCursor: null, totalCount: undefined };
  });
  for (const fresh of [false, true]) {
    const response = await dataRequest(
      new Request(
        `https://naru.pub/api/data/v1/alice/posts${fresh ? "?fresh=1" : ""}`,
      ),
      ["posts"],
      "alice",
    );
    expect(response.headers.get("cache-control")).toBe(
      fresh ? "no-store" : "public, max-age=0, s-maxage=10",
    );
  }
});

test("write requests forward cancellation to admission", async () => {
  const controller = new AbortController();
  const request = new Request("https://naru.pub/api/data/v1/alice/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: 1 }),
    signal: controller.signal,
  });
  await dataRequest(request, ["posts"], "alice");
  expect(execute.mock.calls[0][0].signal).toBe(request.signal);
});

test("admission overload uses the existing uncached UNAVAILABLE protocol", async () => {
  const { DataError } =
    require("../validation") as typeof import("../validation");
  execute.mockRejectedValue(
    new DataError(
      503,
      "Site writes are busy. Try again shortly.",
      "UNAVAILABLE",
    ),
  );
  const response = await dataRequest(
    new Request("https://naru.pub/api/data/v1/alice/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: 1 }),
    }),
    ["posts"],
    "alice",
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    error: {
      code: "UNAVAILABLE",
      message: "Site writes are busy. Try again shortly.",
    },
  });
});

test("canceled queued writes do not log an unexpected server failure", async () => {
  const controller = new AbortController();
  const request = new Request("https://naru.pub/api/data/v1/alice/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: 1 }),
    signal: controller.signal,
  });
  execute.mockImplementation(async () => {
    controller.abort();
    throw controller.signal.reason;
  });
  const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const response = await dataRequest(request, ["posts"], "alice");
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("UNAVAILABLE");
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
