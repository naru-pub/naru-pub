/** @jest-environment node */
import { beforeEach, expect, jest, test } from "@jest/globals";
jest.mock("@/lib/auth", () => ({ validateRequest: jest.fn() }));
jest.mock("../owner-auth", () => ({
  exchangeCode: jest.fn(),
  siteClientId: jest.fn(),
  updateClient: jest.fn(),
  approveAuthorization: jest.fn(),
  authorizationInput: jest.fn((x: unknown) => x),
  revokeToken: jest.fn(),
  registerClient: jest.fn(),
  removeClient: jest.fn(),
  revokeClientTokens: jest.fn(),
}));
const { ownerAuthRequest } =
  require("../auth-http") as typeof import("../auth-http");
const auth = jest.mocked(
  (require("@/lib/auth") as typeof import("@/lib/auth")).validateRequest,
);
const owner = jest.mocked(
  require("../owner-auth") as typeof import("../owner-auth"),
);
beforeEach(() => {
  jest.clearAllMocks();
});

test.each(["authorize", "clients"])(
  "%s requires same-origin confirmation even with login cookies",
  async (action) => {
    for (const origin of ["https://alice.naru.pub", "null", ""]) {
      const response = await ownerAuthRequest(
        new Request(`https://naru.pub/api/data-auth/${action}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(origin ? { Origin: origin } : {}),
            Cookie: "auth_session=owner",
          },
          body: "{}",
        }),
        action,
      );
      expect(response.status).toBe(403);
      expect(auth).not.toHaveBeenCalled();
    }
  },
);
test("authorization cannot issue codes without an authenticated owner", async () => {
  auth.mockResolvedValue({ user: null, session: null });
  const response = await ownerAuthRequest(
    new Request("https://naru.pub/api/data-auth/authorize", {
      method: "POST",
      headers: {
        Origin: "https://naru.pub",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    "authorize",
  );
  expect(response.status).toBe(401);
  expect(owner.approveAuthorization).not.toHaveBeenCalled();
});
test("token exchange ignores ambient cookies and forwards origin to grant verification", async () => {
  owner.exchangeCode.mockResolvedValue({
    accessToken: "t".repeat(43),
    tokenType: "Bearer",
    expiresIn: 86400,
    expiresAt: Date.now() + 24 * 3600000,
  });
  const body = {
    code: "code",
    verifier: "verifier",
    clientId: "client",
    redirectUri: "https://alice.example/admin",
  };
  const response = await ownerAuthRequest(
    new Request("https://naru.pub/api/data-auth/token", {
      method: "POST",
      headers: {
        Origin: "https://alice.example",
        "Content-Type": "application/json",
        Cookie: "auth_session=owner",
      },
      body: JSON.stringify(body),
    }),
    "token",
  );
  expect(response.status).toBe(200);
  expect(owner.exchangeCode).toHaveBeenCalledWith(
    body,
    "https://alice.example",
  );
  expect(auth).not.toHaveBeenCalled();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
});
test("revocation requires explicit bearer credentials", async () => {
  const response = await ownerAuthRequest(
    new Request("https://naru.pub/api/data-auth/revoke", {
      method: "POST",
      headers: {
        Origin: "https://alice.example",
        Cookie: "auth_session=owner",
      },
    }),
    "revoke",
  );
  expect(response.status).toBe(401);
  expect(owner.revokeToken).not.toHaveBeenCalled();
});

test.each(["refresh", "end-session"])(
  "removed route %s returns 404",
  async (action) => {
    const route =
      require("@/app/(main)/api/data-auth/[action]/route") as typeof import("@/app/(main)/api/data-auth/[action]/route");
    const response = await route.POST(
      new Request(`https://naru.pub/api/data-auth/${action}`, {
        method: "POST",
        headers: {
          Origin: "https://alice.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      { params: Promise.resolve({ action }) },
    );
    expect(response.status).toBe(404);
  },
);
