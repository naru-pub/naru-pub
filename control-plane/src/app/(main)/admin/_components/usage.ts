import { sql } from "kysely";
import { db } from "@/lib/database";
import { MAX_MEDIA_FILES, MAX_MEDIA_SITE_BYTES } from "@/lib/site-data/media";
import { MAX_DOCUMENTS, MAX_SITE_BYTES } from "@/lib/site-data/validation";
import { supporterCondition } from "./metrics";

// What each account uses, against the limit where one is enforced. The limits
// are the ones the services check (lib/site-data), so "near the limit" here is
// near where a write starts to be refused.
export const METRICS = [
  {
    key: "storage_bytes",
    label: "사이트 파일",
    unit: "bytes",
    // Measured by the update-home-directory-sizes job, not enforced.
    limit: null,
  },
  {
    key: "db_bytes",
    label: "데이터베이스 용량",
    unit: "bytes",
    limit: MAX_SITE_BYTES,
  },
  {
    key: "db_documents",
    label: "데이터베이스 문서",
    unit: "count",
    limit: MAX_DOCUMENTS,
  },
  {
    key: "media_bytes",
    label: "미디어 용량",
    unit: "bytes",
    limit: MAX_MEDIA_SITE_BYTES,
  },
  {
    key: "media_files",
    label: "미디어 파일",
    unit: "count",
    limit: MAX_MEDIA_FILES,
  },
  { key: "views_30d", label: "30일 페이지뷰", unit: "count", limit: null },
  { key: "custom_domains", label: "커스텀 도메인", unit: "count", limit: null },
] as const;

export type MetricKey = (typeof METRICS)[number]["key"];

export const NEAR_LIMIT = 0.8;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isMetricKey(value: unknown): value is MetricKey {
  return METRICS.some((metric) => metric.key === value);
}

// One row per live account: every metric, zero where there is none.
function usageRows(now: Date) {
  const viewsSince = new Date(now.getTime() - 30 * DAY_MS);
  return db
    .selectFrom("users")
    .leftJoin(
      (eb) =>
        eb
          .selectFrom("site_data_files")
          .select([
            "user_id",
            sql<number>`sum(size_bytes)::float8`.as("bytes"),
            sql<number>`count(*)::float8`.as("files"),
          ])
          .groupBy("user_id")
          .as("media"),
      (join) => join.onRef("media.user_id", "=", "users.id"),
    )
    .leftJoin(
      (eb) =>
        eb
          .selectFrom("pageview_daily_stats")
          .select(["user_id", sql<number>`sum(views)::float8`.as("views")])
          .where(
            sql<boolean>`date >= (${viewsSince}::timestamptz at time zone 'UTC')::date`,
          )
          .groupBy("user_id")
          .as("views"),
      (join) => join.onRef("views.user_id", "=", "users.id"),
    )
    .leftJoin(
      (eb) =>
        eb
          .selectFrom("custom_domains")
          .select(["user_id", sql<number>`count(*)::float8`.as("domains")])
          .groupBy("user_id")
          .as("domains"),
      (join) => join.onRef("domains.user_id", "=", "users.id"),
    )
    .select([
      "users.id",
      "users.login_name",
      "users.supporter_comp",
      supporterCondition(now).as("supporter"),
      sql<number>`coalesce(users.home_directory_size_bytes, 0)::float8`.as(
        "storage_bytes",
      ),
      sql<number>`users.site_data_bytes_used::float8`.as("db_bytes"),
      sql<number>`users.site_data_document_count::float8`.as("db_documents"),
      sql<number>`coalesce(media.bytes, 0)`.as("media_bytes"),
      sql<number>`coalesce(media.files, 0)`.as("media_files"),
      sql<number>`coalesce(views.views, 0)`.as("views_30d"),
      sql<number>`coalesce(domains.domains, 0)`.as("custom_domains"),
    ])
    .where("users.deleted_at", "is", null);
}

// The /admin/usage page's numbers: distributions over every live account, free
// and paid, and the 100 accounts using the most of `sort`.
export async function readUsage(now: Date, sort: MetricKey) {
  const usage = db.with("usage", () => usageRows(now));

  const stats = await usage
    .selectFrom("usage")
    .select((eb) => [
      eb.fn.countAll<number>().as("accounts"),
      sql<number>`count(*) filter (where usage.supporter)::int`.as(
        "supporters",
      ),
      ...METRICS.flatMap((metric) => {
        const ref = sql.ref(`usage.${metric.key}`);
        return [
          sql<number>`count(*) filter (where ${ref} > 0)::int`.as(
            `${metric.key}__used`,
          ),
          sql<number>`coalesce(percentile_disc(0.5) within group (order by ${ref}), 0)`.as(
            `${metric.key}__p50`,
          ),
          sql<number>`coalesce(percentile_disc(0.9) within group (order by ${ref}), 0)`.as(
            `${metric.key}__p90`,
          ),
          sql<number>`coalesce(percentile_disc(0.99) within group (order by ${ref}), 0)`.as(
            `${metric.key}__p99`,
          ),
          sql<number>`coalesce(max(${ref}), 0)`.as(`${metric.key}__max`),
          sql<number>`count(*) filter (where ${
            metric.limit === null
              ? sql<boolean>`false`
              : sql<boolean>`${ref} >= ${metric.limit * NEAR_LIMIT}`
          })::int`.as(`${metric.key}__near`),
        ];
      }),
    ])
    .executeTakeFirstOrThrow();

  const top = await usage
    .selectFrom("usage")
    .selectAll()
    .orderBy(sql.ref(`usage.${sort}`), "desc")
    .orderBy("usage.login_name")
    .limit(100)
    .execute();

  return {
    stat: (key: string) => Number((stats as Record<string, unknown>)[key] ?? 0),
    top,
  };
}
