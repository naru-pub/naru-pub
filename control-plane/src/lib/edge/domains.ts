import { db } from "@/lib/database";
import { addPaymentGrace } from "@/lib/payments/subscriptions";
import { CONFIRMATION_MS, replaceEdgeDomains } from "./client";

// The custom domains the edge serves (edge/src/domains.ts): every domain
// active in Cloudflare and verified, whose owner is paid up, mapped to the
// owner's site. The owner is paid up through the grace period after the last
// paid day, or always for a complimentary account, as the proxy decided.
//
// The whole table is sent each time, so a domain removed here, or whose owner
// lapsed, is gone from the edge on the next push. syncEdge pushes it every few
// minutes; a change to a domain pushes it at once.

/** Sends the edge the current table; returns how many domains it serves. */
export async function pushEdgeDomains() {
  const rows = await db
    .selectFrom("custom_domains")
    .innerJoin("users", "users.id", "custom_domains.user_id")
    .select([
      "custom_domains.hostname",
      "users.login_name",
      "users.supporter_comp",
      "users.supporter_until",
    ])
    .where("custom_domains.verified_at", "is not", null)
    .where("custom_domains.cloudflare_status", "=", "active")
    .where("custom_domains.ssl_status", "=", "active")
    .where("users.deleted_at", "is", null)
    .execute();
  const now = Date.now();
  const domains: Record<
    string,
    { login: string; entitledUntil: number | null }
  > = {};
  for (const row of rows) {
    const entitledUntil = row.supporter_comp
      ? null
      : row.supporter_until
        ? addPaymentGrace(row.supporter_until).getTime()
        : 0;
    if (entitledUntil !== null && entitledUntil <= now) continue;
    domains[row.hostname.toLowerCase()] = {
      login: row.login_name,
      entitledUntil,
    };
  }
  await replaceEdgeDomains({ confirmedUntil: now + CONFIRMATION_MS, domains });
  return Object.keys(domains).length;
}

/**
 * Pushes the table after a domain changed, so the change is served now
 * rather than at the next sync, which retries it if this fails.
 */
export async function pushEdgeDomainsSoon() {
  try {
    await pushEdgeDomains();
  } catch (error) {
    console.error("Pushing custom domains to the edge failed", error);
  }
}
