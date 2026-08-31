/** @jest-environment node */
import { beforeEach, expect, jest, test } from "@jest/globals";
jest.mock("../service", () => ({ executeData: jest.fn() }));
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
  execute.mockResolvedValue({ id: "one" });
});

test("public requests ignore even valid owner cookies", async () => {
  const response = await dataRequest(
    new Request("https://naru.pub/api/data/alice/posts", {
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
    new Request("https://naru.pub/api/data/alice/posts", { method: "OPTIONS" }),
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
    new Request("https://naru.pub/api/data/alice/posts", {
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
test.each(["", "Basic abc", "Bearer malformed"])(
  "invalid authorization never falls back to public access: %s",
  async (authorization) => {
    const response = await dataRequest(
      new Request("https://naru.pub/api/data/alice/posts", {
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
      new Request("https://naru.pub/api/data/alice/posts", {
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

test("list sort and opaque cursor are passed through for both API surfaces", async () => {
  auth.mockResolvedValue({
    user: { id: 1, loginName: "alice" },
    session: {},
  } as never);
  for (const site of ["alice", undefined]) {
    await dataRequest(
      new Request(
        "https://naru.pub/api/data/alice/posts?orderBy=created_at&direction=desc&after=v1.example&limit=7",
      ),
      ["posts"],
      site,
    );
    expect(execute.mock.lastCall![0]).toMatchObject({
      orderBy: "created_at",
      direction: "desc",
      after: "v1.example",
      limit: 7,
    });
  }
});

test("where query JSON is decoded and bounded", async () => {
  const where = { postId: "한글", approved: false };
  const res = await dataRequest(
    new Request(
      `https://naru.pub/api/data/alice/posts?where=${encodeURIComponent(JSON.stringify(where))}`,
    ),
    ["posts"],
    "alice",
  );
  expect(res.status).toBe(200);
  expect(execute.mock.lastCall![0].where).toEqual(where);
  for (const raw of ["{", " ".repeat(2049)]) {
    expect(
      (
        await dataRequest(
          new Request(
            `https://naru.pub/api/data/alice/posts?where=${encodeURIComponent(raw)}`,
          ),
          ["posts"],
          "alice",
        )
      ).status,
    ).toBe(400);
  }
});
