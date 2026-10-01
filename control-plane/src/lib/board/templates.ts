import { sql } from "kysely";
import { db, recordSiteEdit } from "@/lib/database";
import type { User } from "@/lib/auth";
import type { BoardTemplateCollection } from "@/lib/board/template-collections";
import {
  ALLOWED_FILE_EXTENSIONS,
  FILE_EXTENSION_MIMETYPE_MAP,
} from "@/lib/const";
import { getUserFeatures } from "@/lib/entitlements";
import { assertNoPathTraversal } from "@/lib/file-paths";
import {
  collapseSlashes,
  getPublicAssetUrl,
  getUserHomeDirectory,
  getUserObjectKey,
} from "@/lib/site-urls";
import { MAX_COLLECTIONS } from "@/lib/site-data/validation";
import {
  APPLICATIONS_PER_HOUR,
  MAX_CHANGELOG_LENGTH,
  MAX_TEMPLATE_SLUG_LENGTH,
  TEMPLATE_MAX_BYTES,
  TEMPLATE_MAX_FILES,
  TEMPLATE_SLUG_REGEX,
  formatBytes,
  isLicense,
  type License,
} from "./constants";
import { BoardError } from "./errors";
import { assertUnderHourlyLimit } from "./limits";
import { assertCanPost, validatePostBody, validateTitle } from "./posts";
import {
  TEMPLATE_PUBLISHED_CHANNEL,
  getTemplatePreviewUrl,
  templateFileKey,
  templatePrefix,
} from "./preview";
import * as storage from "./storage";

// Where applying a template keeps the files it replaced.
export const BACKUP_DIRECTORY = ".backup";

// "" is the whole site; anything else is a folder, returned as "a/b/".
export function normalizeFolder(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string")
    throw new BoardError(400, "경로가 올바르지 않습니다.");
  const trimmed = collapseSlashes(value.trim())
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    assertNoPathTraversal(trimmed);
  } catch (error: any) {
    throw new BoardError(400, error.message);
  }
  return `${trimmed}/`;
}

function contentTypeFor(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (!path.includes(".") || !ALLOWED_FILE_EXTENSIONS.includes(extension)) {
    return null;
  }
  return (
    FILE_EXTENSION_MIMETYPE_MAP[
      extension as keyof typeof FILE_EXTENSION_MIMETYPE_MAP
    ] ?? "application/octet-stream"
  );
}

export interface TemplateSourceFile {
  // Relative to the template root.
  path: string;
  key: string;
  size: number;
  contentType: string;
}

// The deepest folder that holds every path, as "a/b/", or "" when the paths
// sit in different places or at the top.
export function commonDirectory(paths: string[]): string {
  if (paths.length === 0) return "";
  let common = paths[0].split("/").slice(0, -1);
  for (const path of paths.slice(1)) {
    const directories = path.split("/").slice(0, -1);
    let shared = 0;
    while (
      shared < common.length &&
      shared < directories.length &&
      common[shared] === directories[shared]
    ) {
      shared++;
    }
    common = common.slice(0, shared);
  }
  return common.length > 0 ? `${common.join("/")}/` : "";
}

// The files the author checked, relative to their home directory. The
// template's root is the deepest folder holding all of them, so checking
// hello-world/index.html shares index.html under the root hello-world/.
// Applying it into a new folder then gives that folder's index.html, not
// hello-world/hello-world/index.html. The returned folder is that root.
export async function collectSourceFiles(
  loginName: string,
  paths: string[],
): Promise<{ folder: string; files: TemplateSourceFile[] }> {
  const home = `${getUserHomeDirectory(loginName)}/`;
  const wanted = new Set(paths);
  const files: TemplateSourceFile[] = [];
  for (const object of await storage.listObjects(home)) {
    const path = object.key.slice(home.length);
    if (!wanted.has(path)) continue;
    wanted.delete(path);
    const contentType = contentTypeFor(path);
    if (!contentType) {
      throw new BoardError(
        400,
        `템플릿에 넣을 수 없는 파일 형식입니다: ${path}`,
      );
    }
    files.push({ path, key: object.key, size: object.size, contentType });
  }
  if (wanted.size > 0) {
    throw new BoardError(
      400,
      `파일을 찾을 수 없어요: ${[...wanted].slice(0, 3).join(", ")}`,
    );
  }
  if (files.length === 0) {
    throw new BoardError(400, "공유할 파일을 골라 주세요.");
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > TEMPLATE_MAX_BYTES) {
    throw new BoardError(
      400,
      `템플릿은 ${formatBytes(TEMPLATE_MAX_BYTES)}까지 공유할 수 있어요. (지금 ${formatBytes(total)})`,
    );
  }

  const folder = commonDirectory(files.map((file) => file.path));
  for (const file of files) file.path = file.path.slice(folder.length);
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { folder, files };
}

// The checked files as the request sent them: paths relative to the home
// directory, outside the backups applying templates leaves behind.
function validateSelection(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BoardError(400, "공유할 파일을 골라 주세요.");
  }
  const paths = [...new Set(value as string[])].map((entry) =>
    collapseSlashes(entry).replace(/^\/+/, ""),
  );
  if (paths.length === 0)
    throw new BoardError(400, "공유할 파일을 골라 주세요.");
  if (paths.length > TEMPLATE_MAX_FILES) {
    throw new BoardError(
      400,
      `템플릿에는 파일을 ${TEMPLATE_MAX_FILES}개까지 넣을 수 있어요. (지금 ${paths.length}개)`,
    );
  }
  for (const path of paths) {
    try {
      assertNoPathTraversal(path);
    } catch (error: any) {
      throw new BoardError(400, error.message);
    }
    if (
      !path ||
      path.endsWith("/") ||
      path.startsWith(`${BACKUP_DIRECTORY}/`)
    ) {
      throw new BoardError(400, `템플릿에 넣을 수 없는 경로입니다: ${path}`);
    }
  }
  return paths;
}

// The author's own collections, by name, to be created empty for whoever
// applies the template. Only their permissions travel, never documents.
async function resolveCollections(
  userId: string,
  value: unknown,
): Promise<BoardTemplateCollection[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BoardError(400, "컬렉션 목록이 올바르지 않습니다.");
  }
  const names = [...new Set(value as string[])];
  if (names.length === 0) return [];
  const rows = await db
    .selectFrom("site_data_collections")
    .select(["name", "read_access", "write_access"])
    .where("user_id", "=", userId)
    .where("name", "in", names)
    .execute();
  if (rows.length !== names.length) {
    throw new BoardError(400, "내 데이터베이스에 없는 컬렉션이 있어요.");
  }
  return rows;
}

function validateSlug(value: unknown): string {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    !TEMPLATE_SLUG_REGEX.test(slug) ||
    slug.length > MAX_TEMPLATE_SLUG_LENGTH
  ) {
    throw new BoardError(
      400,
      "템플릿 이름은 영문 소문자, 숫자, 하이픈(-)으로 64자까지 쓸 수 있어요.",
    );
  }
  return slug;
}

function validateChangelog(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new BoardError(400, "변경 내용이 올바르지 않습니다.");
  const changelog = value.trim();
  if (changelog.length > MAX_CHANGELOG_LENGTH) {
    throw new BoardError(
      400,
      `변경 내용은 ${MAX_CHANGELOG_LENGTH}자까지 쓸 수 있어요.`,
    );
  }
  return changelog || null;
}

// Copies every file into the version's prefix. On a failure the partial copy
// is removed and the error rethrown, so the caller's transaction can roll
// back with nothing left in the bucket.
async function copyIntoTemplate(
  templateId: string,
  version: number,
  files: TemplateSourceFile[],
): Promise<void> {
  const copied: string[] = [];
  try {
    for (const file of files) {
      const target = templateFileKey(templateId, version, file.path);
      await storage.copyObject(file.key, target, file.contentType);
      copied.push(target);
    }
  } catch (error) {
    await storage.deleteObjects(copied).catch(() => {});
    throw error;
  }
}

export interface PublishTemplateInput {
  title: unknown;
  body: unknown;
  slug: unknown;
  license: unknown;
  files: unknown;
  collections: unknown;
}

// Creates a template post and publishes its first version in one step.
export async function publishTemplatePost(
  user: User,
  input: PublishTemplateInput,
): Promise<{ postId: string; templateId: string }> {
  const title = validateTitle(input.title);
  const body = validatePostBody(input.body);
  const slug = validateSlug(input.slug);
  if (!isLicense(input.license)) {
    throw new BoardError(400, "라이선스를 골라 주세요.");
  }
  const license: License = input.license;
  const selection = validateSelection(input.files);
  await assertCanPost(user.id);

  const taken = await db
    .selectFrom("board_templates")
    .select("id")
    .where("user_id", "=", user.id)
    .where("slug", "=", slug)
    .executeTakeFirst();
  if (taken) {
    throw new BoardError(409, `이미 「${slug}」라는 템플릿이 있어요.`);
  }

  const collections = await resolveCollections(user.id, input.collections);
  const { folder: root, files } = await collectSourceFiles(
    user.loginName,
    selection,
  );
  const size = files.reduce((sum, file) => sum + file.size, 0);

  return await db.transaction().execute(async (tx) => {
    const post = await tx
      .insertInto("board_posts")
      .values({ user_id: user.id, kind: "template", title, body })
      .returning("id")
      .executeTakeFirstOrThrow();
    const template = await tx
      .insertInto("board_templates")
      .values({
        post_id: post.id,
        user_id: user.id,
        slug,
        license,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const version = await tx
      .insertInto("board_template_versions")
      .values({
        template_id: template.id,
        version: 1,
        source_path: root,
        file_count: files.length,
        size_bytes: size,
        data_collections: JSON.stringify(collections),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("board_template_files")
      .values(
        files.map((file) => ({
          version_id: version.id,
          path: file.path,
          size_bytes: file.size,
          content_type: file.contentType,
        })),
      )
      .execute();
    await tx
      .updateTable("board_templates")
      .set({ latest_version_id: version.id })
      .where("id", "=", template.id)
      .execute();
    await copyIntoTemplate(template.id, 1, files);
    // Delivered on commit, so only a version that exists is rendered.
    await sql`select pg_notify(${TEMPLATE_PUBLISHED_CHANNEL}, '')`.execute(tx);
    return { postId: post.id, templateId: template.id };
  });
}

async function findLiveTemplate(templateId: string) {
  const template = await db
    .selectFrom("board_templates as t")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .leftJoin("board_template_versions as v", "v.id", "t.latest_version_id")
    .select(["t.id", "t.user_id", "t.post_id", "v.version", "v.source_path"])
    .where("t.id", "=", templateId)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!template) throw new BoardError(404, "템플릿을 찾을 수 없습니다.");
  return template;
}

export async function publishTemplateVersion(
  user: User,
  templateId: string,
  input: {
    files: unknown;
    changelog: unknown;
    collections: unknown;
  },
): Promise<number> {
  const template = await findLiveTemplate(templateId);
  if (template.user_id !== user.id) {
    throw new BoardError(403, "내 템플릿만 새 버전을 올릴 수 있어요.");
  }
  const selection = validateSelection(input.files);
  const changelog = validateChangelog(input.changelog);
  const collections = await resolveCollections(user.id, input.collections);
  const { folder: root, files } = await collectSourceFiles(
    user.loginName,
    selection,
  );
  const size = files.reduce((sum, file) => sum + file.size, 0);

  return await db.transaction().execute(async (tx) => {
    // Serialises two publishes of the same template.
    await tx
      .selectFrom("board_templates")
      .select("id")
      .where("id", "=", templateId)
      .forUpdate()
      .execute();
    const latest = await tx
      .selectFrom("board_template_versions")
      .select(sql<number>`coalesce(max(version), 0)`.as("version"))
      .where("template_id", "=", templateId)
      .executeTakeFirstOrThrow();
    const versionNumber = Number(latest.version) + 1;
    const version = await tx
      .insertInto("board_template_versions")
      .values({
        template_id: templateId,
        version: versionNumber,
        source_path: root,
        file_count: files.length,
        size_bytes: size,
        data_collections: JSON.stringify(collections),
        changelog,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("board_template_files")
      .values(
        files.map((file) => ({
          version_id: version.id,
          path: file.path,
          size_bytes: file.size,
          content_type: file.contentType,
        })),
      )
      .execute();
    await tx
      .updateTable("board_templates")
      .set({ latest_version_id: version.id })
      .where("id", "=", templateId)
      .execute();
    await tx
      .updateTable("board_posts")
      .set({ activity_at: sql`now()` })
      .where("id", "=", template.post_id)
      .execute();
    await copyIntoTemplate(templateId, versionNumber, files);
    await sql`select pg_notify(${TEMPLATE_PUBLISHED_CHANNEL}, '')`.execute(tx);
    return versionNumber;
  });
}

export interface TemplateDetail {
  id: string;
  slug: string;
  license: License;
  applyCount: number;
  versions: {
    id: string;
    version: number;
    sourcePath: string;
    fileCount: number;
    sizeBytes: number;
    collections: BoardTemplateCollection[];
    changelog: string | null;
    previewUrl: string | null;
    createdAt: Date;
  }[];
  files: { path: string; sizeBytes: number }[];
}

export async function getTemplateForPost(
  postId: string,
): Promise<TemplateDetail | null> {
  const template = await db
    .selectFrom("board_templates as t")
    .select([
      "t.id",
      "t.slug",
      "t.license",
      "t.apply_count",
      "t.latest_version_id",
    ])
    .where("t.post_id", "=", postId)
    .executeTakeFirst();
  if (!template) return null;

  const versions = await db
    .selectFrom("board_template_versions")
    .selectAll()
    .where("template_id", "=", template.id)
    .orderBy("version", "desc")
    .execute();
  const files = template.latest_version_id
    ? await db
        .selectFrom("board_template_files")
        .select(["path", "size_bytes"])
        .where("version_id", "=", template.latest_version_id)
        .orderBy("path")
        .execute()
    : [];

  return {
    id: template.id,
    slug: template.slug,
    license: template.license,
    applyCount: template.apply_count,
    versions: versions.map((version) => ({
      id: version.id,
      version: version.version,
      sourcePath: version.source_path,
      fileCount: version.file_count,
      sizeBytes: Number(version.size_bytes),
      collections: version.data_collections,
      changelog: version.changelog,
      previewUrl: getTemplatePreviewUrl(
        template.id,
        version.version,
        version.preview_rendered_at,
      ),
      createdAt: version.created_at,
    })),
    files: files.map((file) => ({
      path: file.path,
      sizeBytes: Number(file.size_bytes),
    })),
  };
}

// The users who applied a template, for the "적용함" badge on their replies.
export async function listTemplateAppliers(
  templateId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom("board_template_applications as a")
    .innerJoin("board_template_versions as v", "v.id", "a.version_id")
    .select(["a.user_id", sql<number>`max(v.version)`.as("version")])
    .where("v.template_id", "=", templateId)
    .groupBy("a.user_id")
    .execute();
  return new Map(rows.map((row) => [row.user_id, Number(row.version)]));
}

async function findApplicableVersion(versionId: string) {
  const version = await db
    .selectFrom("board_template_versions as v")
    .innerJoin("board_templates as t", "t.id", "v.template_id")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .select([
      "v.id",
      "v.version",
      "v.template_id",
      "v.data_collections",
      "t.slug",
    ])
    .where("v.id", "=", versionId)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!version) throw new BoardError(404, "템플릿을 찾을 수 없습니다.");
  return version;
}

export interface ApplicationPlan {
  targetPath: string;
  files: {
    path: string;
    sizeBytes: number;
    action: "create" | "overwrite";
  }[];
  collections: {
    name: string;
    action: "create" | "exists" | "unavailable";
  }[];
  totalBytes: number;
}

function normalizeTarget(value: unknown): string {
  const target = normalizeFolder(value);
  if (
    target === `${BACKUP_DIRECTORY}/` ||
    target.startsWith(`${BACKUP_DIRECTORY}/`)
  ) {
    throw new BoardError(400, "백업 폴더에는 적용할 수 없어요.");
  }
  return target;
}

// What applying would do, without writing anything. Apply recomputes it
// rather than trusting the plan the page was shown.
export async function planApplication(
  user: User,
  versionId: string,
  targetInput: unknown,
): Promise<ApplicationPlan> {
  const version = await findApplicableVersion(versionId);
  const targetPath = normalizeTarget(targetInput);
  const files = await db
    .selectFrom("board_template_files")
    .select(["path", "size_bytes"])
    .where("version_id", "=", version.id)
    .orderBy("path")
    .execute();

  const home = `${getUserHomeDirectory(user.loginName)}/`;
  const existing = new Set(
    (await storage.listObjects(`${home}${targetPath}`)).map((object) =>
      object.key.slice(home.length),
    ),
  );

  const hasDatabase = (await getUserFeatures(user.id)).has("database");
  const collectionNames = version.data_collections.map((c) => c.name);
  const existingCollections = new Set(
    collectionNames.length
      ? (
          await db
            .selectFrom("site_data_collections")
            .select("name")
            .where("user_id", "=", user.id)
            .where("name", "in", collectionNames)
            .execute()
        ).map((row) => row.name)
      : [],
  );

  const planned = files.map((file) => {
    const path = `${targetPath}${file.path}`;
    return {
      path,
      sizeBytes: Number(file.size_bytes),
      action: existing.has(path) ? ("overwrite" as const) : ("create" as const),
    };
  });
  return {
    targetPath,
    files: planned,
    collections: collectionNames.map((name) => ({
      name,
      action: existingCollections.has(name)
        ? "exists"
        : hasDatabase
          ? "create"
          : "unavailable",
    })),
    totalBytes: planned.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
}

// The URLs to purge after writing these paths. An index.html is also served
// at its folder's own address, which is the one people visit.
function publicUrls(loginName: string, paths: string[]): string[] {
  const urls: string[] = [];
  for (const path of paths) {
    urls.push(getPublicAssetUrl(loginName, path));
    if (path === "index.html" || path.endsWith("/index.html")) {
      urls.push(
        getPublicAssetUrl(loginName, path.slice(0, -"index.html".length)),
      );
    }
  }
  return urls;
}

function backupStamp(now: Date): string {
  // Seoul time, as the people reading the folder name are in Korea.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}-${get("hour")}${get("minute")}${get("second")}`;
}

export interface ApplicationResult {
  applicationId: string;
  targetPath: string;
  backupPath: string | null;
  written: number;
  overwritten: number;
  createdCollections: string[];
  skippedCollections: string[];
}

export async function applyTemplate(
  user: User,
  versionId: string,
  input: { targetPath: unknown; backup: unknown; createCollections: unknown },
): Promise<ApplicationResult> {
  await assertUnderHourlyLimit(
    "board_template_applications",
    user.id,
    APPLICATIONS_PER_HOUR,
  );
  const version = await findApplicableVersion(versionId);
  const plan = await planApplication(user, versionId, input.targetPath);
  const backup = input.backup !== false;
  const overwritten = plan.files
    .filter((file) => file.action === "overwrite")
    .map((file) => file.path);
  const backupPath =
    backup && overwritten.length > 0
      ? `${BACKUP_DIRECTORY}/${backupStamp(new Date())}/`
      : null;

  // Backups first: if anything after this fails, the originals are safe.
  if (backupPath) {
    for (const path of overwritten) {
      await storage.copyObject(
        getUserObjectKey(user.loginName, path),
        getUserObjectKey(user.loginName, `${backupPath}${path}`),
      );
    }
  }

  const written: string[] = [];
  const sources = await db
    .selectFrom("board_template_files")
    .select(["path", "content_type"])
    .where("version_id", "=", version.id)
    .execute();
  for (const file of sources) {
    const path = `${plan.targetPath}${file.path}`;
    await storage.copyObject(
      templateFileKey(version.template_id, version.version, file.path),
      getUserObjectKey(user.loginName, path),
      file.content_type,
    );
    written.push(path);
  }

  const createdCollections: string[] = [];
  const skippedCollections: string[] = [];
  const wanted = input.createCollections !== false;
  const toCreate = version.data_collections.filter((collection) => {
    const planned = plan.collections.find((c) => c.name === collection.name);
    if (wanted && planned?.action === "create") return true;
    if (planned?.action !== "exists") skippedCollections.push(collection.name);
    return false;
  });

  const application = await db.transaction().execute(async (tx) => {
    if (toCreate.length > 0) {
      const { count } = await tx
        .selectFrom("site_data_collections")
        .select(sql<number>`count(*)::int`.as("count"))
        .where("user_id", "=", user.id)
        .executeTakeFirstOrThrow();
      if (count + toCreate.length > MAX_COLLECTIONS) {
        skippedCollections.push(...toCreate.map((c) => c.name));
      } else {
        const inserted = await tx
          .insertInto("site_data_collections")
          .values(
            toCreate.map((collection) => ({
              user_id: user.id,
              name: collection.name,
              read_access: collection.read_access,
              write_access: collection.write_access,
            })),
          )
          .onConflict((oc) => oc.columns(["user_id", "name"]).doNothing())
          .returning("name")
          .execute();
        createdCollections.push(...inserted.map((row) => row.name));
      }
    }

    const firstTime = !(await tx
      .selectFrom("board_template_applications as a")
      .innerJoin("board_template_versions as v", "v.id", "a.version_id")
      .select("a.id")
      .where("a.user_id", "=", user.id)
      .where("v.template_id", "=", version.template_id)
      .executeTakeFirst());

    const row = await tx
      .insertInto("board_template_applications")
      .values({
        version_id: version.id,
        user_id: user.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    if (firstTime) {
      await tx
        .updateTable("board_templates")
        .set({ apply_count: sql`apply_count + 1` })
        .where("id", "=", version.template_id)
        .execute();
    }
    return row;
  });

  await recordSiteEdit(user.id);
  await storage.purgeUrls(publicUrls(user.loginName, written));

  return {
    applicationId: application.id,
    targetPath: plan.targetPath,
    backupPath,
    written: written.length,
    overwritten: overwritten.length,
    createdCollections,
    skippedCollections,
  };
}

// Removes a template's files and previews from R2. The rows stay (the post is
// soft-deleted), so the record of who applied it is kept.
export async function deleteTemplateObjects(templateId: string): Promise<void> {
  await storage.deletePrefix(templatePrefix(templateId));
  const screenshots = process.env.S3_BUCKET_NAME_SCREENSHOTS;
  if (screenshots) {
    await storage.deletePrefix(templatePrefix(templateId), screenshots);
  }
}

// Account deletion: the rows cascade with the user, but R2 does not.
export async function deleteUserTemplateObjects(userId: string): Promise<void> {
  const templates = await db
    .selectFrom("board_templates")
    .select("id")
    .where("user_id", "=", userId)
    .execute();
  for (const template of templates) {
    await deleteTemplateObjects(template.id);
  }
}
