import { describe, expect, test } from "@jest/globals";
import { hasVerifiedEmail } from "@/lib/support";

describe("support email verification requirement", () => {
  test("allows a user with a verified email address", () => {
    expect(
      hasVerifiedEmail({
        email: "supporter@example.com",
        emailVerifiedAt: new Date("2026-09-01T00:00:00Z"),
      }),
    ).toBe(true);
  });

  test("blocks an email that was added but never verified", () => {
    expect(
      hasVerifiedEmail({
        email: "supporter@example.com",
        emailVerifiedAt: null,
      }),
    ).toBe(false);
  });

  test("blocks a user with no email address at all", () => {
    expect(hasVerifiedEmail({ email: null, emailVerifiedAt: null })).toBe(
      false,
    );
  });
});
