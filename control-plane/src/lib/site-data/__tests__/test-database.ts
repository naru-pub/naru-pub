import { up as usageUp } from "@/migrations/1791377967407_site_data_usage_counters";
import { up as backendUp } from "@/migrations/1791514826830_site_data_backend";
import { up as removePostgresUp } from "@/migrations/1791519830591_remove_postgres_site_data";
import { up as uuidUp } from "@/migrations/1791346354414_site_data_uuid_columns";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { up as baseUp } from "@/migrations/1788176027971_add_site_database";
import { up as authUp } from "@/migrations/1788177446828_add_site_data_owner_auth";

import { up as sortingUp } from "@/migrations/1788180032055_add_site_data_created_at";

import { up as filterUp } from "@/migrations/1788205003689_add_site_data_filter_index";

import { up as sessionsUp } from "@/migrations/1788206726527_stable_site_clients_and_owner_sessions";

import { up as lifetimeUp } from "@/migrations/1788208716196_configurable_admin_token_lifetime";
import { up as filesUp } from "@/migrations/1788264228670_add_site_data_files";
import { up as fileMetadataUp } from "@/migrations/1788296417049_add_site_data_file_metadata";
import { up as versionUp } from "@/migrations/1788299234629_add_site_data_document_version";
import { up as fileVersionUp } from "@/migrations/1788944200000_add_site_data_file_version";
import { up as dropFileMetadataUp } from "@/migrations/1789273289882_drop_site_data_file_metadata";
import { up as dropFileVersionUp } from "@/migrations/1789273609493_drop_site_data_file_version";
import { up as dropSiteClientsUp } from "@/migrations/1790078516190_drop_site_data_site_clients";
import { up as slideTokensUp } from "@/migrations/1790110700000_slide_site_data_access_tokens";

import { up as orderingUp } from "@/migrations/1790200121054_explicit_document_ordering";

/**
 * The site-data schema of a disposable naru_data_test database. Documents and
 * collections are in Durable Objects; `postgresSiteData` keeps the PostgreSQL
 * tables they had, for tests of the migrations that once changed them.
 */
export async function setupTestDatabase({ postgresSiteData = false } = {}) {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/naru_data_test")
    throw new Error("Use a disposable naru_data_test database.");
  await sql`create table users(id serial primary key, login_name text not null unique,
    supporter_comp boolean not null default true, supporter_until timestamptz, deleted_at timestamptz)`.execute(
    db,
  );
  await sql`create table subscriptions(id serial primary key, user_id integer not null unique references users(id) on delete cascade, plan text not null default 'supporter')`.execute(
    db,
  );
  await sql`create table sessions(id text primary key, user_id integer not null references users(id) on delete cascade, expires_at timestamptz not null)`.execute(
    db,
  );
  await sql`create table custom_domains(id serial primary key, user_id integer references users(id), hostname text,
    verified_at timestamptz, cloudflare_status text, ssl_status text)`.execute(
    db,
  );
  await baseUp(db);
  await authUp(db);
  await sortingUp(db);
  await filterUp(db);
  await sessionsUp(db);
  await lifetimeUp(db);
  await filesUp(db);
  await fileMetadataUp(db);
  await versionUp(db);
  await fileVersionUp(db);
  await dropFileMetadataUp(db);
  await dropFileVersionUp(db);
  await dropSiteClientsUp(db);
  await slideTokensUp(db);
  await orderingUp(db);
  await uuidUp(db);
  await db.transaction().execute((tx) => usageUp(tx));
  await backendUp(db);
  if (postgresSiteData) return;
  await removePostgresUp(db);
  // Collections are the objects', which name them with UUIDs, as PostgreSQL
  // has since migration 1790824144110; this schema predates that.
  for (const table of [
    "site_data_clients",
    "site_data_auth_codes",
    "site_data_access_tokens",
  ])
    await sql`alter table ${sql.table(table)} alter column collection_ids type uuid[] using collection_ids::text[]::uuid[]`.execute(
      db,
    );
}
export async function teardownTestDatabase() {
  // The last migrations cannot be reversed, so the schema goes as a whole.
  await sql`drop schema public cascade`.execute(db);
  await sql`create schema public`.execute(db);
}
