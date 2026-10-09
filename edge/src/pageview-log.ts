import { DurableObject } from "cloudflare:workers";

// Pageviews of the hosted sites the edge serves (pages.ts), held until the
// control plane takes them into PostgreSQL. The edge cannot write there, and
// should not wait on it: while the Mac mini is down, visits keep landing here
// and are counted when it is back. One object takes every site's, a few per
// second at most.
//
// The control plane's pageview-drain job reads the oldest events (`drain`),
// stores them, then deletes what it stored (`ack`), so an event it fails to
// store is read again on the next run.

/** A navigation to a hosted page; the control plane resolves the login. */
export type PageviewEvent = {
  login: string;
  /** Epoch ms. */
  timestamp: number;
  path: string;
  ip: string;
  referrer: string | null;
  userAgent: string | null;
};

export type LoggedPageview = PageviewEvent & { id: number };

/**
 * Events kept while nothing drains them: two weeks of the busiest day so far.
 * Past it the oldest go first, so an outage costs its earliest analytics,
 * never the edge's storage.
 */
const CAPACITY = 6_000_000;
const MAX_DRAIN = 1000;

export class PageviewLog extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL)",
    );
  }

  async record(event: PageviewEvent) {
    const [{ id }] = this.sql
      .exec<{
        id: number;
      }>(
        "INSERT INTO events (event) VALUES (?) RETURNING id",
        JSON.stringify(event),
      )
      .toArray();
    if (id > CAPACITY)
      this.sql.exec("DELETE FROM events WHERE id <= ?", id - CAPACITY);
  }

  /** The oldest events, at most `limit`, left in place until acknowledged. */
  async drain(input: { limit?: number }): Promise<LoggedPageview[]> {
    const limit = Math.min(
      Math.max(Number(input.limit) || MAX_DRAIN, 1),
      MAX_DRAIN,
    );
    return this.sql
      .exec<{
        id: number;
        event: string;
      }>("SELECT id, event FROM events ORDER BY id LIMIT ?", limit)
      .toArray()
      .map((row) => ({ ...JSON.parse(row.event), id: row.id }));
  }

  /** Forgets every event up to and including `through`, once stored. */
  async ack(input: { through: number }) {
    this.sql.exec("DELETE FROM events WHERE id <= ?", Number(input.through));
    return null;
  }
}
