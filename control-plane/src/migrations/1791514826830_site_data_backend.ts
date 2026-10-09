import { sql, type Kysely } from "kysely";

// Which store holds a site's collections and documents. A site moves one at a
// time (src/cli/site-data-move.ts): while `moving_*` it is read from where it
// came from and refuses writes, so none can land on the side being copied.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table users
    add column site_data_backend text not null default 'postgres',
    add constraint users_site_data_backend_check check (site_data_backend in
      ('postgres', 'moving_to_durable_object', 'durable_object', 'moving_to_postgres'))`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table users drop column site_data_backend`.execute(db);
}
