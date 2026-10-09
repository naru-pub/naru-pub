/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import { jsonBody, MAX_DOCUMENT_BYTES } from "../validation";

describe("request validation", () => {
  test("rejects oversized bodies without Content-Length", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(MAX_DOCUMENT_BYTES) }),
    });
    await expect(jsonBody(request)).rejects.toMatchObject({ status: 413 });
  });
  test.each(["[]", "null", "{"])(
    "rejects malformed envelope %s",
    async (body) => {
      await expect(
        jsonBody(
          new Request("http://localhost", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }),
        ),
      ).rejects.toMatchObject({ status: 400 });
    },
  );
});
