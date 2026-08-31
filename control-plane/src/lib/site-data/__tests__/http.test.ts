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
