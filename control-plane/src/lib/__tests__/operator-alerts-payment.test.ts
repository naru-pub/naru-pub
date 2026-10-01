/** @jest-environment node */
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { sendOperatorAlert } from "@/lib/operator-alerts";

describe("operator alerts", () => {
  const sent: Array<{
    url: string;
    body: { content: string; allowed_mentions: unknown };
  }> = [];
  const fetchMock = jest.fn(async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  });

  afterEach(() => {
    sent.length = 0;
    jest.restoreAllMocks();
    delete process.env.OPERATOR_DISCORD_WEBHOOK_URL;
  });

  function withWebhook() {
    process.env.OPERATOR_DISCORD_WEBHOOK_URL = "https://discord.test/hook";
    jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(fetchMock as unknown as typeof fetch);
  }

  test("posts the title and lines, mentioning no one", async () => {
    withWebhook();
    await sendOperatorAlert({
      title: "작업 실패: x",
      lines: ["@everyone a", "b"],
    });
    expect(sent).toEqual([
      {
        url: "https://discord.test/hook",
        body: {
          content: "**작업 실패: x**\n@everyone a\nb",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });

  test("keeps a long digest within one message and says what is left out", async () => {
    withWebhook();
    const lines = Array.from(
      { length: 200 },
      (_, i) => `line ${i} ${"x".repeat(40)}`,
    );
    await sendOperatorAlert({
      title: "t",
      lines,
      more: "https://naru.pub/admin/events",
    });
    const content = sent[0].body.content;
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toMatch(/… 외 \d+건 — https:\/\/naru\.pub\/admin\/events$/);
  });

  test("throws when Discord does not take it, so the caller tries again", async () => {
    process.env.OPERATOR_DISCORD_WEBHOOK_URL = "https://discord.test/hook";
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("rate limited", { status: 429 }));
    await expect(sendOperatorAlert({ title: "t", lines: [] })).rejects.toThrow(
      "429",
    );
  });
});
