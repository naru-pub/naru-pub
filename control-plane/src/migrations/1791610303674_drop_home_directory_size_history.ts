import { sql, type Kysely } from "kysely";

// Every home directory size measurement since 2025 was appended here and none
// was ever read: users.home_directory_size_bytes holds the current size, the
// only one anything shows. Several million rows, the database's second
// largest table.
//
// Run with the service stopped: the previous release inserts a row on every
// deploy and every size update.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`drop table home_directory_size_history`.execute(db);
}

// The table comes back empty; the dropped rows are gone.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    create table home_directory_size_history (
      id uuid primary key default uuid_v7(),
      user_id uuid references users(id) on delete cascade,
      size_bytes integer not null,
      recorded_at timestamp not null default now()
    )
  `.execute(db);
  await sql`create index home_directory_size_history_user_id_recorded_at_idx
    on home_directory_size_history(user_id, recorded_at)`.execute(db);
}
