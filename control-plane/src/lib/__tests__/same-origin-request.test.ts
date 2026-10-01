/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import type { NextRequest } from "next/server";
import { assertJsonContentType, assertSameOriginRequest } from "@/lib/utils";

// jest.setup.js swaps the global Request for a stub without real headers.
const request = (headers: Record<string, string>) =>
  ({ method: "POST", headers: new Headers(headers) }) as unknown as NextRequest;

describe("assertSameOriginRequest", () => {
  test("allows requests from naru.pub itself", () => {
    expect(() =>
      assertSameOriginRequest(request({ "Sec-Fetch-Site": "same-origin" })),
    ).not.toThrow();
  });

  test.each(["same-site", "cross-site"])(
    "refuses %s requests, such as from <login>.naru.pub",
    (site) => {
      expect(() =>
        assertSameOriginRequest(request({ "Sec-Fetch-Site": site })),
      ).toThrow();
    },
  );
});

describe("assertJsonContentType", () => {
  test("allows application/json with parameters", () => {
    expect(() =>
      assertJsonContentType(
        request({
          "Content-Type": "application/json; charset=utf-8",
          "Sec-Fetch-Site": "same-origin",
        }),
      ),
    ).not.toThrow();
  });

  test("refuses a simple content type that merely mentions application/json", () => {
    expect(() =>
      assertJsonContentType(
        request({ "Content-Type": "text/plain; x=application/json" }),
      ),
    ).toThrow();
  });

  test("refuses JSON from a subdomain", () => {
    expect(() =>
      assertJsonContentType(
        request({
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-site",
        }),
      ),
    ).toThrow();
  });
});
