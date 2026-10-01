// A data collection a board template declares, as stored in
// board_template_versions.data_collections (jsonb). Referenced from the
// generated src/lib/db.d.ts through .kysely-codegenrc.json.
export interface BoardTemplateCollection {
  name: string;
  read_access: string;
  write_access: string;
}
