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
}
export async function teardownTestDatabase() {
  await authDown(db);
  await baseDown(db);
  await db.schema.dropTable("custom_domains").execute();
  await db.schema.dropTable("sessions").execute();
  await db.schema.dropTable("users").execute();
}
