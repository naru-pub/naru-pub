import { sql, type Kysely } from "kysely";

// Pageviews are kept as daily rollups instead of one row per view and one per
// visitor address: per site (pageview_daily_stats, as before), per path, per
// referrer and per browser. Raw pageviews were the database's largest table,
// over a gigabyte for 35 days, and only the analytics page's three top-ten
// lists read them.
//
// Distinct visitors are HyperLogLog sketches (the postgresql-hll extension)
// per site and per path, so the 7- and 30-day figures can count a returning
// visitor once without keeping any address. A visitor is
// hll_hash_text(host(ip)); sketches have 2^14 registers (log2m 14), so they
// stay exact sets of hashes up to about 1,280 visitors and are within about
// 0.8% past that. Sketches only union with sketches of the same log2m.
//
// The 35 days of raw pageviews and visitor addresses still kept are rolled up
// here, then both tables are dropped.
//
// Run with the service stopped: the previous release writes raw pageviews.

const visitors = sql.raw(`hll_add_agg(hll_hash_text(host(ip)), 14)`);

export async function up(db: Kysely<any>): Promise<void> {
  // Packaged as postgresql-hll by Homebrew, postgresql-18-hll by apt.
  await sql`create extension if not exists hll`.execute(db);
  await sql`
    create table pageview_daily_paths (
      id uuid primary key default uuid_v7(),
      user_id uuid not null references users(id) on delete cascade,
      date date not null,
      path text not null,
      views integer not null,
      visitors hll not null,
      unique (user_id, date, path)
    )
  `.execute(db);
  // '' is a visit without a referrer.
  await sql`
    create table pageview_daily_referrers (
      id uuid primary key default uuid_v7(),
      user_id uuid not null references users(id) on delete cascade,
      date date not null,
      referrer text not null,
      views integer not null,
      unique (user_id, date, referrer)
    )
  `.execute(db);
  await sql`
    create table pageview_daily_browsers (
      id uuid primary key default uuid_v7(),
      user_id uuid not null references users(id) on delete cascade,
      date date not null,
      browser text not null,
      views integer not null,
      unique (user_id, date, browser)
    )
  `.execute(db);
  for (const table of [
    "pageview_daily_paths",
    "pageview_daily_referrers",
    "pageview_daily_browsers",
  ])
    await sql`create index ${sql.raw(`${table}_date_id_idx`)}
      on ${sql.table(table)}(date, id)`.execute(db);
  // Null once a day falls out of retention, and for days before any sketch.
  await sql`alter table pageview_daily_stats add column visitors hll`.execute(
    db,
  );

  await sql`
    insert into pageview_daily_paths (user_id, date, path, views, visitors)
    select user_id, (timestamp at time zone 'UTC')::date, path, count(*),
      ${visitors}
    from pageviews
    group by 1, 2, 3
  `.execute(db);
  await sql`
    insert into pageview_daily_referrers (user_id, date, referrer, views)
    select user_id, (timestamp at time zone 'UTC')::date, coalesce(referrer, ''),
      count(*)
    from pageviews
    group by 1, 2, 3
  `.execute(db);
  // src/lib/analytics/browsers.ts, as it was.
  await sql`
    insert into pageview_daily_browsers (user_id, date, browser, views)
    select user_id, (timestamp at time zone 'UTC')::date,
      case
        when coalesce(user_agent, '') = '' then '(알 수 없음)'
        when strpos(user_agent, 'Firefox/') > 0
          and strpos(user_agent, 'Seamonkey/') = 0 then 'Firefox'
        when strpos(user_agent, 'Edg/') > 0 then 'Edge'
        when strpos(user_agent, 'OPR/') > 0
          or strpos(user_agent, 'Opera/') > 0 then 'Opera'
        when strpos(user_agent, 'SamsungBrowser/') > 0 then 'Samsung Internet'
        when strpos(user_agent, 'Chrome/') > 0 then 'Chrome'
        when strpos(user_agent, 'Safari/') > 0
          and strpos(user_agent, 'Chromium/') = 0 then 'Safari'
        when strpos(user_agent, 'bot') > 0 or strpos(user_agent, 'Bot') > 0
          or strpos(user_agent, 'crawl') > 0 or strpos(user_agent, 'Crawl') > 0
          or strpos(user_agent, 'spider') > 0
          or strpos(user_agent, 'Spider') > 0 then 'Bot'
        when strpos(user_agent, 'curl/') > 0 then 'curl'
        else '(기타)'
      end,
      count(*)
    from pageviews
    group by 1, 2, 3
  `.execute(db);
  // Both tables, for days either has: the visitor addresses cover every view
  // since they were introduced, the raw views the days before. Daily counts
  // keep the values they were counted with.
  await sql`
    update pageview_daily_stats as stats set visitors = days.visitors
    from (
      select user_id, date, ${visitors} as visitors
      from (
        select user_id, (timestamp at time zone 'UTC')::date as date, ip
        from pageviews
        union all
        select user_id, date, ip from pageview_daily_visitors
      ) as visits
      group by user_id, date
    ) as days
    where stats.user_id = days.user_id and stats.date = days.date
  `.execute(db);

  await sql`drop table pageviews`.execute(db);
  await sql`drop table pageview_daily_visitors`.execute(db);
}

// The raw tables come back empty; what they held survives only as rollups.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    create table pageviews (
      id uuid primary key default uuid_v7(),
      user_id uuid not null references users(id) on delete cascade,
      timestamp timestamptz not null default now(),
      path text not null default '/',
      ip inet not null,
      referrer text,
      user_agent text
    )
  `.execute(db);
  await sql`create index pageviews_timestamp_idx on pageviews(timestamp)`.execute(
    db,
  );
  await sql`create index pageviews_user_id_timestamp_idx
    on pageviews(user_id, timestamp)`.execute(db);
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
  await sql`alter table pageview_daily_stats drop column visitors`.execute(db);
  await sql`drop table pageview_daily_browsers`.execute(db);
  await sql`drop table pageview_daily_referrers`.execute(db);
  await sql`drop table pageview_daily_paths`.execute(db);
  await sql`drop extension hll`.execute(db);
}
