/** @jest-environment node */
import { afterAll, describe, expect, jest, test } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";

// The Worker stands in, keeping the custom domain tables it is sent.
const tables: {
  confirmedUntil: number;
  domains: Record<string, { login: string; entitledUntil: number | null }>;
}[] = [];
jest.mock("@/lib/edge/client", () => ({
  CONFIRMATION_MS: 60_000,
  replaceEdgeDomains: async (table: (typeof tables)[number]) => {
    tables.push(table);
    return null;
  },
}));
const { pushEdgeDomains } =
  require("@/lib/edge/domains") as typeof import("@/lib/edge/domains");

const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

integration("edge custom domains", () => {
  afterAll(async () => {
    await db.destroy();
  });

  test("sends every active domain of a paid-up owner, until the grace period ends", async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const paid = now + day;
    const users: string[] = [];
    const user = async (login: string, comp: boolean, until: number | null) => {
      const { id } = await db
        .insertInto("users")
        .values({
          login_name: login,
          password_hash: "x",
          supporter_comp: comp,
          supporter_until: until === null ? null : new Date(until),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      users.push(id);
      return id;
    };
    const domain = (host: string, userId: string, active = true) =>
      sql`insert into custom_domains (user_id, hostname, cloudflare_hostname_id,
            cloudflare_status, ssl_status, verified_at)
          values (${userId}, ${host}, ${`cf-${host}`}, ${active ? "active" : "pending"},
            ${active ? "active" : "pending_validation"}, ${active ? new Date() : null})`.execute(
        db,
      );
    try {
      await domain("comp.example", await user("edge-comp", true, null));
      await domain("paid.example", await user("edge-paid", false, paid));
      await domain(
        "grace.example",
        await user("edge-grace", false, now - 2 * day),
      );
      await domain(
        "expired.example",
        await user("edge-expired", false, now - 10 * day),
      );
      await domain(
        "pending.example",
        await user("edge-pending", false, paid),
        false,
      );

      expect(await pushEdgeDomains()).toBe(3);
      const table = tables.at(-1)!;
      expect(table.confirmedUntil).toBeGreaterThan(now);
      expect(table.domains).toEqual({
        "comp.example": { login: "edge-comp", entitledUntil: null },
        "grace.example": {
          login: "edge-grace",
          entitledUntil: expect.any(Number),
        },
        "paid.example": {
          login: "edge-paid",
          entitledUntil: expect.any(Number),
        },
      });
      // Four days of grace after the last paid day.
      expect(
        Math.round((table.domains["paid.example"].entitledUntil! - paid) / day),
      ).toBe(4);
    } finally {
      await db.deleteFrom("users").where("id", "in", users).execute();
    }
  });
});
