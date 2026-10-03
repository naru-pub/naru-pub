import {
  PAYMENT_QUEUE,
  PAYMENT_TASK,
  PAYMENT_RETRY_OPTIONS,
} from "./payment-jobs";

export const RENEWAL_SCHEDULE_NAME = "naru-renewal-scan";
export const RENEWAL_SCHEDULE = "0 * * * *";
// Static SQL only; pg_cron executes this in the application database. The UTC
// hour's key collapses deployment catch-up and duplicate scheduler triggers.
export const RENEWAL_SCAN_COMMAND = `select absurd.spawn_task(
  '${PAYMENT_QUEUE}', '${PAYMENT_TASK}', '{"job":{"kind":"enqueue_due_renewals"}}'::jsonb,
  '${JSON.stringify(PAYMENT_RETRY_OPTIONS)}'::jsonb || jsonb_build_object(
    'idempotency_key', 'renewal-scan:' || extract(epoch from date_trunc('hour', now() at time zone 'UTC') at time zone 'UTC')::bigint::text
  )
);`;
