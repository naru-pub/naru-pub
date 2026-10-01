import { sql, type Kysely } from "kysely";

// Every table keyed by a sequence number is keyed by a UUIDv7 instead, like
// the payment tables before it (1790817060775, which defines uuid_v7()).
// Every column that points at one follows: the foreign keys, found from the
// catalog rather than listed here so none is missed, and the id arrays that
// have no foreign key (board_replies.path, the site-data grants'
// collection_ids). New board posts get v7 ids too; posts already published
// keep theirs.
//
// Existing rows get ids made from their own creation time, ties broken by the
// old sequence number, so id order stays creation order: reply threads sort by
// their id path, followers page by id. Tables with no timestamp keep their old
// order at the time of migration.
//
// legacy_ids keeps the old numbers. Storage keys were built from them — media
// under <user id>/, template files and previews under _templates/<template
// id>/ — so cleanup still reaches the old prefixes (deleteUserMedia), and
// copy-legacy-template-storage copies template files to their new prefix.
//
// Run with the service stopped: the previous release reads and writes the old
// integer ids.

// Tables whose ids are referenced elsewhere or used in storage keys: their
// old numbers are kept in legacy_ids. ts orders the new ids (null: old order).
const MAPPED: Array<{ table: string; ts: string | null; type: string }> = [
  { table: "users", ts: "created_at", type: "integer" },
  { table: "remote_actors", ts: "created_at", type: "integer" },
  { table: "followers", ts: "created_at", type: "integer" },
  { table: "custom_domains", ts: "created_at", type: "integer" },
  { table: "github_deploy_targets", ts: "created_at", type: "integer" },
  { table: "home_directory_exports", ts: "created_at", type: "integer" },
  { table: "site_data_collections", ts: null, type: "integer" },
  { table: "board_replies", ts: "created_at", type: "bigint" },
  { table: "board_notifications", ts: "created_at", type: "bigint" },
  { table: "board_templates", ts: null, type: "bigint" },
  { table: "board_template_versions", ts: "created_at", type: "bigint" },
  { table: "board_template_applications", ts: "created_at", type: "bigint" },
];

// Append-only logs nothing points at: new ids straight from their timestamps,
// without a mapping.
const UNMAPPED: Array<{ table: string; ts: string; type: string }> = [
  { table: "pageviews", ts: "timestamp", type: "integer" },
  { table: "home_directory_size_history", ts: "recorded_at", type: "integer" },
];

// Id arrays without a foreign key: [table, column, the table they hold ids of].
const ARRAYS: Array<{ table: string; column: string; of: string }> = [
  { table: "board_replies", column: "path", of: "board_replies" },
  {
    table: "site_data_clients",
    column: "collection_ids",
    of: "site_data_collections",
  },
  {
    table: "site_data_auth_codes",
    column: "collection_ids",
    of: "site_data_collections",
  },
  {
    table: "site_data_access_tokens",
    column: "collection_ids",
    of: "site_data_collections",
  },
];

const ALL = [...MAPPED, ...UNMAPPED];
const typeOf = (table: string) => ALL.find((t) => t.table === table)!.type;

type ForeignKey = {
  tbl: string;
  conname: string;
  def: string;
  target: string;
  col: string;
};

async function foreignKeysInto(db: Kysely<any>) {
  const { rows } = await sql<ForeignKey>`
    select conrelid::regclass::text as tbl, conname,
      pg_get_constraintdef(oid) as def,
      confrelid::regclass::text as target,
      (select attname from pg_attribute
        where attrelid = conrelid and attnum = conkey[1]) as col
    from pg_constraint
    where contype = 'f'
      and confrelid::regclass::text = any(${ALL.map((t) => t.table)}::text[])
    order by 1, 2
  `.execute(db);
  return rows;
}

// One ALTER TABLE per table, so each table is rewritten once.
async function alterEach(
  db: Kysely<any>,
  clauses: Map<string, string[]>,
): Promise<void> {
  for (const [table, list] of clauses) {
    await sql.raw(`alter table ${table} ${list.join(", ")}`).execute(db);
  }
}

function add(clauses: Map<string, string[]>, table: string, clause: string) {
  clauses.set(table, [...(clauses.get(table) ?? []), clause]);
}

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create table legacy_ids (
      table_name text not null,
      old_id bigint not null,
      new_id uuid not null unique,
      primary key (table_name, old_id)
    )
  `.execute(db);

  for (const { table, ts } of MAPPED) {
    const at = ts ? `coalesce(${ts}, now())` : "now()";
    await sql
      .raw(
        `insert into legacy_ids (table_name, old_id, new_id)
         select '${table}', id, uuid_v7(at) from (
           select id, ${at} + (row_number() over (
             partition by ${at} order by id) - 1) * interval '1 microsecond' as at
           from ${table}) ranked`,
      )
      .execute(db);
  }

  await sql`
    create function legacy_uuid(t text, old bigint) returns uuid
    language sql stable as $$
      select new_id from legacy_ids where table_name = t and old_id = old
    $$
  `.execute(db);
  await sql`
    create function legacy_uuid_array(t text, olds bigint[]) returns uuid[]
    language sql stable as $$
      select coalesce(array_agg(legacy_uuid(t, o) order by n), '{}')
      from unnest(olds) with ordinality as u(o, n)
    $$
  `.execute(db);

  const foreignKeys = await foreignKeysInto(db);
  for (const fk of foreignKeys) {
    await sql
      .raw(`alter table ${fk.tbl} drop constraint ${fk.conname}`)
      .execute(db);
  }

  const sequences = new Map<string, string>();
  for (const { table } of ALL) {
    const { rows } = await sql<{ seq: string | null }>`
      select pg_get_serial_sequence(${table}, 'id') as seq
    `.execute(db);
    if (rows[0]?.seq) sequences.set(table, rows[0].seq);
  }

  const clauses = new Map<string, string[]>();
  for (const { table } of MAPPED) {
    add(clauses, table, `alter column id drop default`);
    add(
      clauses,
      table,
      `alter column id type uuid using legacy_uuid('${table}', id)`,
    );
    add(clauses, table, `alter column id set default uuid_v7()`);
  }
  for (const { table, ts } of UNMAPPED) {
    add(clauses, table, `alter column id drop default`);
    add(clauses, table, `alter column id type uuid using uuid_v7("${ts}")`);
    add(clauses, table, `alter column id set default uuid_v7()`);
  }
  for (const fk of foreignKeys) {
    add(
      clauses,
      fk.tbl,
      `alter column ${fk.col} type uuid using legacy_uuid('${fk.target}', ${fk.col})`,
    );
  }
  for (const { table, column, of } of ARRAYS) {
    add(
      clauses,
      table,
      `alter column ${column} type uuid[] using legacy_uuid_array('${of}', ${column}::bigint[])`,
    );
  }
  await alterEach(db, clauses);

  for (const seq of sequences.values()) {
    await sql.raw(`drop sequence if exists ${seq}`).execute(db);
  }
  for (const fk of foreignKeys) {
    await sql
      .raw(`alter table ${fk.tbl} add constraint ${fk.conname} ${fk.def}`)
      .execute(db);
  }

  await sql`alter table board_posts alter column id set default uuid_v7()`.execute(
    db,
  );
}

// Back to sequence numbers: rows from before keep their old numbers, rows made
// since get new ones after them, in id order.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table board_posts alter column id set default gen_random_uuid()`.execute(
    db,
  );

  for (const { table } of ALL) {
    await sql
      .raw(
        `insert into legacy_ids (table_name, old_id, new_id)
         select '${table}',
           coalesce((select max(old_id) from legacy_ids where table_name = '${table}'), 0)
             + row_number() over (order by id),
           id
         from ${table}
         where not exists (
           select 1 from legacy_ids l where l.table_name = '${table}' and l.new_id = ${table}.id)`,
      )
      .execute(db);
  }

  await sql`
    create function legacy_old(t text, new uuid) returns bigint
    language sql stable as $$
      select old_id from legacy_ids where table_name = t and new_id = new
    $$
  `.execute(db);
  await sql`
    create function legacy_old_array(t text, news uuid[]) returns bigint[]
    language sql stable as $$
      select coalesce(array_agg(legacy_old(t, u) order by n), '{}')
      from unnest(news) with ordinality as x(u, n)
    $$
  `.execute(db);

  const foreignKeys = await foreignKeysInto(db);
  for (const fk of foreignKeys) {
    await sql
      .raw(`alter table ${fk.tbl} drop constraint ${fk.conname}`)
      .execute(db);
  }

  const clauses = new Map<string, string[]>();
  for (const { table, type } of ALL) {
    add(clauses, table, `alter column id drop default`);
    add(
      clauses,
      table,
      `alter column id type ${type} using legacy_old('${table}', id)`,
    );
  }
  for (const fk of foreignKeys) {
    add(
      clauses,
      fk.tbl,
      `alter column ${fk.col} type ${typeOf(fk.target)} using legacy_old('${fk.target}', ${fk.col})`,
    );
  }
  for (const { table, column, of } of ARRAYS) {
    add(
      clauses,
      table,
      `alter column ${column} type ${typeOf(of)}[] using legacy_old_array('${of}', ${column})`,
    );
  }
  await alterEach(db, clauses);

  for (const { table, type } of ALL) {
    const seq = `${table}_id_seq`;
    await sql
      .raw(`create sequence ${seq} as ${type} owned by ${table}.id`)
      .execute(db);
    await sql
      .raw(
        `select setval('${seq}', coalesce((select max(id) from ${table}), 0) + 1, false)`,
      )
      .execute(db);
    await sql
      .raw(`alter table ${table} alter column id set default nextval('${seq}')`)
      .execute(db);
  }
  for (const fk of foreignKeys) {
    await sql
      .raw(`alter table ${fk.tbl} add constraint ${fk.conname} ${fk.def}`)
      .execute(db);
  }

  await sql`drop function legacy_old_array(text, uuid[])`.execute(db);
  await sql`drop function legacy_old(text, uuid)`.execute(db);
  await sql`drop function legacy_uuid_array(text, bigint[])`.execute(db);
  await sql`drop function legacy_uuid(text, bigint)`.execute(db);
  await sql`drop table legacy_ids`.execute(db);
}
