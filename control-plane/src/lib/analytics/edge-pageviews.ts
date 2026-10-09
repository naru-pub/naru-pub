import { isIP } from "node:net";
import { sql, type Kysely } from "kysely";
import type { DB } from "@/lib/db";
import { callPageviewLog } from "@/lib/edge/client";

// Pageviews of hosted sites (edge/src/pages.ts) wait in the edge Worker's
// pageview log until this takes them into the pageview tables, with the rules
// the retired proxy wrote them by: a day is the visit's UTC date, and a
// visitor is counted once per site and day.

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
    let stored = 0;
    for (const event of fresh) {
      const userId = ids.get(event.login);
      if (!userId || !isIP(event.ip)) continue;
      const at = new Date(event.timestamp);
      const visitor = await sql`
        insert into pageview_daily_visitors (user_id, date, ip)
        values (${userId}, (${at}::timestamptz at time zone 'UTC')::date, ${event.ip}::inet)
        on conflict (user_id, date, ip) do nothing`.execute(tx);
      await sql`
        insert into pageviews (user_id, timestamp, path, ip, referrer, user_agent)
        values (${userId}, ${at}, ${event.path}, ${event.ip}::inet, ${event.referrer}, ${event.userAgent})`.execute(
        tx,
      );
      await sql`
        insert into pageview_daily_stats (user_id, date, views, unique_visitors)
        values (${userId}, (${at}::timestamptz at time zone 'UTC')::date, 1, ${Number(visitor.numAffectedRows ?? 0)})
        on conflict (user_id, date) do update set
          views = pageview_daily_stats.views + 1,
          unique_visitors = pageview_daily_stats.unique_visitors + excluded.unique_visitors`.execute(
        tx,
      );
      stored += 1;
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
    return { stored, skipped: events.length - stored };
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
