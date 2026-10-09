import { LOGIN_NAME_REGEX } from "../../control-plane/src/lib/const";

// Custom domains: hostnames a paying user has pointed at Naru through
// Cloudflare for SaaS, each serving that user's site. The control plane keeps
// the whole table in one KV entry and replaces it on every sync (every five
// minutes, and when a domain changes), so a lookup is one cached read.
//
// A domain is served while its owner is paid up, by the same rule the proxy
// used: through the grace period after the last paid day, or indefinitely for
// complimentary accounts. The table is confirmed like a site's paid status
// (site.ts): past `confirmedUntil`, which each sync renews, no domain is
// served, so a revocation is never outlived by a stale table.

export interface DomainsEnv {
  /** Holds the table under DOMAINS_KEY. */
  DOMAINS: KVNamespace;
}

export type DomainTable = {
  /** Epoch ms; the table is not relied on after it. */
  confirmedUntil: number;
  domains: Record<
    string,
    {
      login: string;
      /** Epoch ms when the owner's paid period, with grace, ends; null never. */
      entitledUntil: number | null;
    }
  >;
};

const DOMAINS_KEY = "domains";
// KV caches the entry at each location for a minute; this isolate keeps what
// it read for half that, so a busy domain costs no read per request.
const KV_CACHE_SECONDS = 60;
const MEMO_MS = 30_000;
const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

let memo: { table: DomainTable | null; until: number } | undefined;

async function table(env: DomainsEnv) {
  if (memo && Date.now() < memo.until) return memo.table;
  const value = await env.DOMAINS.get<DomainTable>(DOMAINS_KEY, {
    type: "json",
    cacheTtl: KV_CACHE_SECONDS,
  });
  memo = { table: value, until: Date.now() + MEMO_MS };
  return value;
}

/** The site a custom domain serves now, or null. */
export async function domainSite(host: string, env: DomainsEnv) {
  const name = host.replace(/\.$/, "").toLowerCase();
  const current = await table(env);
  const now = Date.now();
  if (!current || current.confirmedUntil <= now) return null;
  const domain = current.domains[name];
  if (!domain) return null;
  if (domain.entitledUntil !== null && domain.entitledUntil <= now) return null;
  return domain.login;
}

/** Checks a table from the control plane; the reason it is refused, or null. */
export function invalidTable(input: unknown): string | null {
  const value = input as Partial<DomainTable> | null;
  if (!value || typeof value !== "object") return "Expected a table.";
  if (!Number.isSafeInteger(value.confirmedUntil))
    return "confirmedUntil must be epoch ms.";
  if (!value.domains || typeof value.domains !== "object")
    return "domains must be an object.";
  for (const [host, domain] of Object.entries(value.domains)) {
    if (!HOSTNAME.test(host)) return `Not a hostname: ${host}`;
    if (!domain || !LOGIN_NAME_REGEX.test(domain.login))
      return `Not a login for ${host}.`;
    if (
      domain.entitledUntil !== null &&
      !Number.isSafeInteger(domain.entitledUntil)
    )
      return `entitledUntil for ${host} must be epoch ms or null.`;
  }
  return null;
}

/** Replaces the table. */
export async function storeDomains(env: DomainsEnv, value: DomainTable) {
  await env.DOMAINS.put(DOMAINS_KEY, JSON.stringify(value));
  memo = undefined;
}
