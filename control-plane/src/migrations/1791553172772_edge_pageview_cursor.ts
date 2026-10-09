import { sql, type Kysely } from "kysely";

// How far the pageview-drain job has stored the edge's pageview log
// (site-data-worker/src/pageview-log.ts). The job stores a batch and moves
// this in one transaction before telling the log to forget the batch, so a
// batch the log hands out again, after a lost acknowledgement, is skipped
// rather than counted twice. One row per log; there is one, "pageviews".
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create table edge_pageview_cursors (
      id uuid primary key default uuid_v7(),
      log text not null unique,
      last_event_id bigint not null
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table edge_pageview_cursors`.execute(db);
}
