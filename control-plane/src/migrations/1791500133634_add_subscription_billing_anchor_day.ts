import { sql, type Kysely } from "kysely";

// The day of the month (KST) a plan renews on (lib/payments/toss,
// billingAnchorDay), so a plan started on the 31st renews on the 31st again
// after a short month instead of drifting to the 28th. Null renews on the day
// the period starts.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table subscriptions
      add column billing_anchor_day smallint
        check (billing_anchor_day between 1 and 31)
  `.execute(db);
  // A live plan whose current period ends on its start day's clamp (Jan 31 to
  // Feb 28) keeps the start day; any other plan renews on its end day, as it
  // did before.
  await sql`
    with kst as (
      select
        id,
        (current_period_start at time zone 'UTC') + interval '9 hours' as starts,
        (current_period_end at time zone 'UTC') + interval '9 hours' as ends
      from subscriptions
      where status in ('active', 'scheduled', 'past_due')
        and current_period_start is not null
        and current_period_end is not null
    )
    update subscriptions s
    set billing_anchor_day = case
      when least(
        extract(day from kst.starts),
        extract(day from date_trunc('month', kst.ends) + interval '1 month - 1 day')
      ) = extract(day from kst.ends)
        then extract(day from kst.starts)
      else extract(day from kst.ends)
    end
    from kst
    where s.id = kst.id
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("subscriptions")
    .dropColumn("billing_anchor_day")
    .execute();
}
