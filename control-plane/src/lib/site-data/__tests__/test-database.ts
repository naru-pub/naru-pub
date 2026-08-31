import { sql } from "kysely";
import { db } from "@/lib/database";
import {
  up as baseUp,
  down as baseDown,
} from "@/migrations/1788176027971_add_site_database";
import {
  up as authUp,
  down as authDown,
} from "@/migrations/1788177446828_add_site_data_owner_auth";

import {
  up as sortingUp,
  down as sortingDown,
} from "@/migrations/1788180032055_add_site_data_created_at";

import {
  up as filterUp,
  down as filterDown,
} from "@/migrations/1788205003689_add_site_data_filter_index";

import {
  up as sessionsUp,
  down as sessionsDown,
} from "@/migrations/1788206726527_stable_site_clients_and_owner_sessions";

import {
  up as lifetimeUp,
  down as lifetimeDown,
} from "@/migrations/1788208716196_configurable_admin_token_lifetime";

export async function setupTestDatabase() {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/naru_data_test")
    throw new Error("Use a disposable naru_data_test database.");
  await sql`create table users(id serial primary key, login_name text not null unique)`.execute(
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
}
export async function teardownTestDatabase() {
  await lifetimeDown(db);
  await sessionsDown(db);
  await filterDown(db);
  await sortingDown(db);
  await authDown(db);
  await baseDown(db);
  await db.schema.dropTable("custom_domains").execute();
  await db.schema.dropTable("sessions").execute();
  await db.schema.dropTable("users").execute();
}
