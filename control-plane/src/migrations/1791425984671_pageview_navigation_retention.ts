import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create table pageview_daily_visitors (
      id uuid primary key default uuid_v7(),
      user_id uuid not null references users(id) on delete cascade,
      date date not null,
      ip inet not null,
      unique (user_id, date, ip)
    )
  `.execute(db);
  await sql`create index pageview_daily_visitors_date_id_idx
    on pageview_daily_visitors(date, id)`.execute(db);
  // Seed the cutover day only. Historical totals retain their original meaning;
  // no site-specific filtering and no pruning in the schema migration.
  await sql`
    insert into pageview_daily_visitors (user_id, date, ip)
    select distinct user_id, (timestamp at time zone 'UTC')::date, ip
    from pageviews
    where timestamp >= ((now() at time zone 'UTC')::date::timestamp at time zone 'UTC')
    on conflict (user_id, date, ip) do nothing
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("pageview_daily_visitors").execute();
}
