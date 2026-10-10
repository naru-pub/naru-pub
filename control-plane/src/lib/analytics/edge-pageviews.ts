import { isIP } from "node:net";
import { sql, type Kysely } from "kysely";
import type { DB } from "@/lib/db";
import { callPageviewLog } from "@/lib/edge/client";
import { browserName } from "./browsers";

// Pageviews of hosted sites (edge/src/pages.ts) wait in the edge Worker's
// pageview log until this adds them to the daily rollups: per site, path,
// referrer and browser. A day is the visit's UTC date. Distinct visitors per
// site and per path are HyperLogLog sketches (postgresql-hll) of
// hll_hash_text(host(ip)), with log2m 14 like those the pageview-rollup
// migration built, since only sketches of the same log2m union; the
// addresses themselves are not kept.

const LOG = "pageviews";
const BATCH = 1000;

/** An event as the log hands it out (pageview-log.ts LoggedPageview). */
export type LoggedPageview = {
  id: number;
  login: string;
  timestamp: number;
  path: string;
  ip: string;
  referrer: string | null;
  userAgent: string | null;
};

/**
 * Stores one batch and records the last event's id, in one transaction.
 * Events at or below the recorded id were stored before, and are skipped;
 * so are those of sites that no longer exist and those without an address.
 */
export async function storePageviews(db: Kysely<DB>, events: LoggedPageview[]) {
  return db.transaction().execute(async (tx) => {
    await sql`set local statement_timeout = '30s'`.execute(tx);
    const cursor = await tx
      .selectFrom("edge_pageview_cursors")
      .select("last_event_id")
      .where("log", "=", LOG)
      .forUpdate()
      .executeTakeFirst();
    const after = Number(cursor?.last_event_id ?? 0);
    const fresh = events.filter((event) => event.id > after);
    const logins = [...new Set(fresh.map((event) => event.login))];
    const users = logins.length
      ? await tx
          .selectFrom("users")
          .select(["id", "login_name"])
          .where("login_name", "in", logins)
          .execute()
      : [];
    const ids = new Map(users.map((user) => [user.login_name, user.id]));
    const valid = fresh.flatMap((event) => {
      const userId = ids.get(event.login);
      return userId && isIP(event.ip) ? [{ ...event, userId }] : [];
    });

    if (valid.length) {
      // The batch as a table, one row per pageview.
      const batch = sql`unnest(
        ${valid.map((event) => event.userId)}::uuid[],
        ${valid.map((event) => new Date(event.timestamp).toISOString().slice(0, 10))}::date[],
        ${valid.map((event) => event.path)}::text[],
        ${valid.map((event) => event.ip)}::inet[],
        ${valid.map((event) => event.referrer ?? "")}::text[],
        ${valid.map((event) => browserName(event.userAgent))}::text[]
      ) as pageview(user_id, date, path, ip, referrer, browser)`;
      const visitors = sql`hll_add_agg(hll_hash_text(host(ip)), 14)`;
      // A day counted before it had a sketch can only add to its count, and
      // keeps no sketch: hll_union with null is null.
      await sql`
        insert into pageview_daily_stats as stats
          (user_id, date, views, unique_visitors, visitors)
        select user_id, date, count(*), round(hll_cardinality(${visitors})),
          ${visitors}
        from ${batch} group by 1, 2
        on conflict (user_id, date) do update set
          views = stats.views + excluded.views,
          visitors = hll_union(stats.visitors, excluded.visitors),
          unique_visitors = case
            when stats.visitors is null
            then stats.unique_visitors + round(hll_cardinality(excluded.visitors))
            else round(hll_cardinality(hll_union(stats.visitors, excluded.visitors)))
          end`.execute(tx);
      await sql`
        insert into pageview_daily_paths as paths
          (user_id, date, path, views, visitors)
        select user_id, date, path, count(*), ${visitors}
        from ${batch} group by 1, 2, 3
        on conflict (user_id, date, path) do update set
          views = paths.views + excluded.views,
          visitors = hll_union(paths.visitors, excluded.visitors)`.execute(tx);
      await sql`
        insert into pageview_daily_referrers as referrers
          (user_id, date, referrer, views)
        select user_id, date, referrer, count(*)
        from ${batch} group by 1, 2, 3
        on conflict (user_id, date, referrer) do update set
          views = referrers.views + excluded.views`.execute(tx);
      await sql`
        insert into pageview_daily_browsers as browsers
          (user_id, date, browser, views)
        select user_id, date, browser, count(*)
        from ${batch} group by 1, 2, 3
        on conflict (user_id, date, browser) do update set
          views = browsers.views + excluded.views`.execute(tx);
    }

    const last = events.at(-1)?.id ?? after;
    if (last > after)
      await tx
        .insertInto("edge_pageview_cursors")
        .values({ log: LOG, last_event_id: String(last) })
        .onConflict((conflict) =>
          conflict.column("log").doUpdateSet({ last_event_id: String(last) }),
        )
        .execute();
    return { stored: valid.length, skipped: events.length - valid.length };
  });
}

/**
 * Takes everything waiting in the edge's log into PostgreSQL, a batch at a
 * time: store, then acknowledge. Stops after `maxBatches`, so a backlog after
 * an outage is worked off over several runs rather than in one long one;
 * `waitingSince` is then when the oldest event still waiting was recorded.
 */
export async function drainEdgePageviews(db: Kysely<DB>, maxBatches = 20) {
  let stored = 0;
  let skipped = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const events = await callPageviewLog<LoggedPageview[]>("drain", {
      limit: BATCH,
    });
    if (!events.length) break;
    const result = await storePageviews(db, events);
    stored += result.stored;
    skipped += result.skipped;
    await callPageviewLog("ack", { through: events.at(-1)!.id });
    if (events.length < BATCH) return { stored, skipped, waitingSince: null };
  }
  const [oldest] = await callPageviewLog<LoggedPageview[]>("drain", {
    limit: 1,
  });
  return { stored, skipped, waitingSince: oldest?.timestamp ?? null };
}
