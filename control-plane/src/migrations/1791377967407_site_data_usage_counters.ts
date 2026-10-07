import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // The migration transaction keeps the backfill and trigger installation
  // atomic. Existing application versions can continue calculating usage:
  // their writes also maintain these counters after the migration commits.
  await sql`alter table users
    add column site_data_document_count bigint not null default 0,
    add column site_data_bytes_used bigint not null default 0,
    add constraint site_data_usage_nonnegative check
      (site_data_document_count >= 0 and site_data_bytes_used >= 0)`.execute(
    db,
  );
  await sql`lock table site_data_collections, site_data_documents in share row exclusive mode`.execute(
    db,
  );
  await sql`update users u set
    site_data_document_count = usage.documents,
    site_data_bytes_used = usage.bytes
    from (select c.user_id, count(*) as documents, sum(d.size_bytes) as bytes
      from site_data_documents d join site_data_collections c on c.id=d.collection_id
      group by c.user_id) usage where u.id=usage.user_id`.execute(db);

  // Statement transition tables make a bulk write update each owner's counters
  // once. Replacing equal-sized documents does not update the owner at all.
  for (const [event, changes, relations] of [
    [
      "insert",
      "select collection_id, size_bytes::bigint as bytes, 1::bigint as documents from new_documents",
      "new table as new_documents",
    ],
    [
      "delete",
      "select collection_id, -size_bytes::bigint as bytes, -1::bigint as documents from old_documents",
      "old table as old_documents",
    ],
    [
      "update",
      "select collection_id, size_bytes::bigint as bytes, 1::bigint as documents from new_documents union all select collection_id, -size_bytes::bigint as bytes, -1::bigint as documents from old_documents",
      "old table as old_documents new table as new_documents",
    ],
  ]) {
    await sql
      .raw(
        `create function site_data_usage_${event}() returns trigger language plpgsql as $$
      begin
        update users u set
          site_data_document_count = u.site_data_document_count + delta.documents,
          site_data_bytes_used = u.site_data_bytes_used + delta.bytes
        from (select c.user_id, sum(change.documents) as documents, sum(change.bytes) as bytes
          from (${changes}) change join site_data_collections c on c.id=change.collection_id
          group by c.user_id having sum(change.documents) <> 0 or sum(change.bytes) <> 0) delta
        where u.id=delta.user_id;
        return null;
      end $$`,
      )
      .execute(db);
    await sql
      .raw(
        `create trigger site_data_usage_${event} after ${event} on site_data_documents
      referencing ${relations} for each statement execute function site_data_usage_${event}()`,
      )
      .execute(db);
  }

  // During FK cascade the parent collection is no longer visible to the
  // document trigger. Subtract its usage while the collection still exists.
  await sql`create function site_data_usage_collection_delete() returns trigger language plpgsql as $$
    begin
      update users set
        site_data_document_count = site_data_document_count - usage.documents,
        site_data_bytes_used = site_data_bytes_used - usage.bytes
      from (select count(*) as documents, coalesce(sum(size_bytes), 0) as bytes
        from site_data_documents where collection_id=old.id) usage
      where users.id=old.user_id and usage.documents <> 0;
      return old;
    end $$`.execute(db);
  await sql`create trigger site_data_usage_collection_delete before delete on site_data_collections
    for each row execute function site_data_usage_collection_delete()`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop trigger site_data_usage_collection_delete on site_data_collections`.execute(
    db,
  );
  await sql`drop function site_data_usage_collection_delete()`.execute(db);
  for (const event of ["insert", "delete", "update"]) {
    await sql
      .raw(`drop trigger site_data_usage_${event} on site_data_documents`)
      .execute(db);
    await sql.raw(`drop function site_data_usage_${event}()`).execute(db);
  }
  await sql`alter table users drop constraint site_data_usage_nonnegative,
    drop column site_data_document_count, drop column site_data_bytes_used`.execute(
    db,
  );
}
