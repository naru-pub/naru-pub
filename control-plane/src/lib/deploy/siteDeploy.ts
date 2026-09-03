import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomBytes } from "crypto";
import * as Sentry from "@sentry/nextjs";
import { db, recordSiteEdit } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { noteSupporterFeatureUse } from "@/lib/feature-usage";
import { extractHtmlTitle } from "@/lib/html";
import {
  ALLOWED_FILE_EXTENSIONS,
  FILE_EXTENSION_MIMETYPE_MAP,
} from "@/lib/const";
import { getUserHomeDirectory, s3Client } from "@/lib/utils";
import { GitHubActionsClaims } from "./githubOidc";

const MAX_USER_DIRECTORY_SIZE_BYTES = 1024 * 1024 * 1024;
const MAX_DEPLOY_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const DEPLOYMENT_TTL_MS = 60 * 60 * 1000;
const UPLOAD_URL_TTL_SECONDS = 15 * 60;

export type DeployManifestFile = {
  path: string;
  sha256: string;
  size: number;
  contentType?: string;
};

export type DeployManifest = {
  files: DeployManifestFile[];
};

type UserRow = {
  id: number;
};

function deploymentId() {
  return randomBytes(24).toString("base64url");
}

function assertSha256(value: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("Invalid sha256 value");
  }
}

export function normalizeDeployPath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.length > 1000) {
    throw new Error("Invalid file path");
  }
  if (normalized.includes("//")) {
    throw new Error("File path contains empty segments");
  }
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Path traversal detected");
  }

  const extension = normalized.split(".").pop()?.toLowerCase();
  if (!extension || !ALLOWED_FILE_EXTENSIONS.includes(extension)) {
    throw new Error(`Unsupported file extension for ${normalized}`);
  }

  return normalized;
}

export function normalizeTargetPrefix(prefix: string | null | undefined) {
  const raw = (prefix ?? "").replaceAll("\\", "/").trim();
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return "";
  if (normalized.length > 1000) {
    throw new Error("Target prefix is too long");
  }
  if (
    normalized.includes("//") ||
    normalized.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Invalid target prefix");
  }
  return normalized;
}

function publicPath(targetPrefix: string, path: string) {
  return targetPrefix ? `${targetPrefix}/${path}` : path;
}

function contentTypeFor(file: DeployManifestFile) {
  if (file.contentType) return file.contentType;
  return FILE_EXTENSION_MIMETYPE_MAP[file.path.split(".").pop()!.toLowerCase()];
}

export function validateManifest(input: unknown): DeployManifest {
  if (
    !input ||
    typeof input !== "object" ||
    !Array.isArray((input as any).files)
  ) {
    throw new Error("Manifest files are required");
  }

  const seen = new Set<string>();
  const files = (input as any).files.map((file: any) => {
    if (!file || typeof file !== "object") {
      throw new Error("Invalid manifest file");
    }
    const path = normalizeDeployPath(String(file.path ?? ""));
    if (seen.has(path)) {
      throw new Error(`Duplicate manifest path: ${path}`);
    }
    seen.add(path);

    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid size for ${path}`);
    }
    if (size > MAX_DEPLOY_FILE_SIZE_BYTES) {
      throw new Error(`File is too large: ${path}`);
    }

    const sha256 = String(file.sha256 ?? "").toLowerCase();
    assertSha256(sha256);

    return {
      path,
      sha256,
      size,
      contentType:
        typeof file.contentType === "string" && file.contentType
          ? file.contentType
          : undefined,
    };
  }) as DeployManifestFile[];

  if (!files.some((file) => file.path === "index.html")) {
    throw new Error("Deploy manifest must include index.html");
  }

  return { files };
}

function manifestFiles(value: unknown): DeployManifestFile[] {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as any).files)
  ) {
    return [];
  }
  return (value as any).files
    .filter((file: any) => file && typeof file.path === "string")
    .map((file: any) => ({
      path: normalizeDeployPath(file.path),
      sha256: String(file.sha256 ?? ""),
      size: Number(file.size ?? 0),
      contentType:
        typeof file.contentType === "string" ? file.contentType : undefined,
    }));
}

function manifestTotalSize(files: DeployManifestFile[]) {
  return files.reduce((sum, file) => sum + file.size, 0);
}

async function calculateUserHomeDirectorySize(loginName: string) {
  const prefix = `${getUserHomeDirectory(loginName)}/`;
  let totalSize = 0;
  let continuationToken: string | undefined;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET_NAME!,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    totalSize +=
      response.Contents?.reduce((sum, object) => sum + (object.Size || 0), 0) ??
      0;
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return totalSize;
}

async function updateUserHomeDirectorySize(userId: number, loginName: string) {
  const directorySize = await calculateUserHomeDirectorySize(loginName);
  const now = new Date();

  await db
    .updateTable("users")
    .set({
      home_directory_size_bytes: directorySize,
      home_directory_size_bytes_updated_at: now,
    })
    .where("id", "=", userId)
    .execute();

  await db
    .insertInto("home_directory_size_history")
    .values({
      user_id: userId,
      size_bytes: directorySize,
      recorded_at: now,
    })
    .execute();

  return directorySize;
}

async function purgeCloudflareFiles(loginName: string, paths: string[]) {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const userApiToken = process.env.CLOUDFLARE_USER_API_TOKEN;
  if (!zoneId || !userApiToken || paths.length === 0) return;

  const files = paths.map((path) =>
    `${getUserHomeDirectory(loginName)}/${path}`.replaceAll("//", "/"),
  );

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userApiToken}`,
      },
      body: JSON.stringify({ files }),
    },
  );

  if (!response.ok) {
    Sentry.captureException(response);
  }
}

async function deleteObjects(keys: string[]) {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    if (batch.length === 0) continue;

    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
        },
      }),
    );
  }
}

async function readObjectText(key: string) {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: key,
    }),
  );
  return response.Body?.transformToString() ?? "";
}

async function sha256Object(key: string) {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: key,
    }),
  );
  const bytes = await response.Body?.transformToByteArray();
  return createHash("sha256")
    .update(Buffer.from(bytes ?? []))
    .digest("hex");
}

function assertGitHubClaimsAllowed(
  claims: GitHubActionsClaims,
  target: {
    github_repository: string;
    github_ref: string;
  },
) {
  if (claims.repository !== target.github_repository) {
    throw new Error("GitHub repository is not allowed for this target");
  }
  if (claims.ref !== target.github_ref) {
    throw new Error("GitHub ref is not allowed for this target");
  }
  if (
    claims.sub !== `repo:${target.github_repository}:ref:${target.github_ref}`
  ) {
    throw new Error("GitHub OIDC subject is not allowed for this target");
  }
}

export async function createGitHubDeploymentPlan(params: {
  claims: GitHubActionsClaims;
  site: string;
  targetPrefix?: string | null;
  manifest: unknown;
}) {
  const targetPrefix = normalizeTargetPrefix(params.targetPrefix);
  const manifest = validateManifest(params.manifest);
  const requestedBytes = manifestTotalSize(manifest.files);
  if (requestedBytes > MAX_USER_DIRECTORY_SIZE_BYTES) {
    throw new Error("Deploy exceeds the maximum user directory size");
  }

  const target = await db
    .selectFrom("github_deploy_targets")
    .innerJoin("users", "users.id", "github_deploy_targets.user_id")
    .select([
      "github_deploy_targets.id",
      "github_deploy_targets.user_id",
      "github_deploy_targets.github_repository",
      "github_deploy_targets.github_ref",
      "github_deploy_targets.target_prefix",
      "github_deploy_targets.delete_removed_files",
      "github_deploy_targets.last_manifest",
      "users.login_name",
    ])
    .where("users.login_name", "=", params.site)
    .where(
      "github_deploy_targets.github_repository",
      "=",
      params.claims.repository,
    )
    .where("github_deploy_targets.github_ref", "=", params.claims.ref)
    .where("github_deploy_targets.target_prefix", "=", targetPrefix)
    .where("github_deploy_targets.enabled", "=", true)
    .executeTakeFirst();

  if (!target) {
    throw new Error("No enabled GitHub deploy target matches this request");
  }

  if (!(await userHasFeature(target.user_id, "github_deploys"))) {
    throw new Error("GitHub deploys are available to supporters only");
  }
  noteSupporterFeatureUse(target.user_id, "github_deploys");

  assertGitHubClaimsAllowed(params.claims, target);

  const currentSize = await calculateUserHomeDirectorySize(target.login_name);
  const previousFiles = manifestFiles(target.last_manifest);
  const previousBytes = manifestTotalSize(previousFiles);
  const estimatedFinalSize =
    Math.max(0, currentSize - previousBytes) + requestedBytes;
  if (estimatedFinalSize > MAX_USER_DIRECTORY_SIZE_BYTES) {
    throw new Error("Deploy would exceed the maximum user directory size");
  }

  const previousPaths = new Set(previousFiles.map((file) => file.path));
  const nextPaths = new Set(manifest.files.map((file) => file.path));
  const deletedPaths = target.delete_removed_files
    ? [...previousPaths].filter((path) => !nextPaths.has(path))
    : [];

  const id = deploymentId();
  const uploadPrefix = `__deploy_uploads/${target.user_id}/${id}`;
  const expiresAt = new Date(Date.now() + DEPLOYMENT_TTL_MS);

  await db
    .insertInto("github_deployments")
    .values({
      id,
      target_id: target.id,
      user_id: target.user_id,
      status: "planned",
      github_repository: params.claims.repository,
      github_ref: params.claims.ref,
      github_sha: params.claims.sha,
      target_prefix: targetPrefix,
      upload_prefix: uploadPrefix,
      delete_removed_files: target.delete_removed_files,
      manifest,
      deleted_paths: deletedPaths,
      expires_at: expiresAt,
    })
    .execute();

  const uploads = await Promise.all(
    manifest.files.map(async (file) => {
      const key = `${uploadPrefix}/${file.path}`;
      const url = await getSignedUrl(
        s3Client as any,
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME!,
          Key: key,
        }) as any,
        { expiresIn: UPLOAD_URL_TTL_SECONDS },
      );

      return {
        path: file.path,
        method: "PUT",
        url,
        headers: {},
      };
    }),
  );

  return {
    deploymentId: id,
    expiresAt: expiresAt.toISOString(),
    uploads,
    deletedPaths,
  };
}

export async function finalizeGitHubDeployment(params: {
  claims: GitHubActionsClaims;
  deploymentId: string;
}) {
  const deployment = await db
    .selectFrom("github_deployments")
    .innerJoin("users", "users.id", "github_deployments.user_id")
    .innerJoin(
      "github_deploy_targets",
      "github_deploy_targets.id",
      "github_deployments.target_id",
    )
    .select([
      "github_deployments.id",
      "github_deployments.target_id",
      "github_deployments.user_id",
      "github_deployments.status",
      "github_deployments.github_repository",
      "github_deployments.github_ref",
      "github_deployments.github_sha",
      "github_deployments.target_prefix",
      "github_deployments.upload_prefix",
      "github_deployments.manifest",
      "github_deployments.deleted_paths",
      "github_deployments.expires_at",
      "github_deploy_targets.enabled",
      "users.login_name",
    ])
    .where("github_deployments.id", "=", params.deploymentId)
    .executeTakeFirst();

  if (!deployment) {
    throw new Error("Deployment was not found");
  }
  if (deployment.status !== "planned") {
    throw new Error("Deployment is not ready to finalize");
  }
  if (!deployment.enabled) {
    throw new Error("Deploy target is disabled");
  }
  if (new Date(deployment.expires_at).getTime() <= Date.now()) {
    throw new Error("Deployment has expired");
  }
  assertGitHubClaimsAllowed(params.claims, deployment);
  if (params.claims.sha !== deployment.github_sha) {
    throw new Error("GitHub commit does not match this deployment");
  }

  const manifest = validateManifest(deployment.manifest);
  const deletedPaths = Array.isArray(deployment.deleted_paths)
    ? deployment.deleted_paths.map((path) => normalizeDeployPath(String(path)))
    : [];

  try {
    for (const file of manifest.files) {
      const stagingKey = `${deployment.upload_prefix}/${file.path}`;
      const head = await s3Client.send(
        new HeadObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME!,
          Key: stagingKey,
        }),
      );

      if (head.ContentLength !== file.size) {
        throw new Error(
          `Uploaded size does not match manifest for ${file.path}`,
        );
      }
      if ((await sha256Object(stagingKey)) !== file.sha256) {
        throw new Error(
          `Uploaded checksum does not match manifest for ${file.path}`,
        );
      }
    }

    const rootIndex = manifest.files.find((file) => file.path === "index.html");
    const rootIndexKey =
      rootIndex && deployment.target_prefix === ""
        ? `${deployment.upload_prefix}/${rootIndex.path}`
        : null;
    const siteTitle = rootIndexKey
      ? extractHtmlTitle(await readObjectText(rootIndexKey))
      : null;

    for (const file of manifest.files) {
      const stagingKey = `${deployment.upload_prefix}/${file.path}`;
      const targetPath = publicPath(deployment.target_prefix, file.path);
      const publicKey = `${getUserHomeDirectory(
        deployment.login_name,
      )}/${targetPath}`.replaceAll("//", "/");

      await s3Client.send(
        new CopyObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME!,
          CopySource: `${process.env.S3_BUCKET_NAME!}/${encodeURIComponent(
            stagingKey,
          )}`,
          Key: publicKey,
          ContentType: contentTypeFor(file),
          Metadata: { sha256: file.sha256 },
          MetadataDirective: "REPLACE",
        }),
      );
    }

    const publicDeleteKeys = deletedPaths.map((path) =>
      `${getUserHomeDirectory(deployment.login_name)}/${publicPath(
        deployment.target_prefix,
        path,
      )}`.replaceAll("//", "/"),
    );
    await deleteObjects(publicDeleteKeys);

    await deleteObjects(
      manifest.files.map((file) => `${deployment.upload_prefix}/${file.path}`),
    );

    await recordSiteEdit(deployment.user_id);

    if (deployment.target_prefix === "") {
      await db
        .updateTable("users")
        .set({ site_title: siteTitle })
        .where("id", "=", deployment.user_id)
        .execute();
    }

    const directorySize = await updateUserHomeDirectorySize(
      deployment.user_id,
      deployment.login_name,
    );

    await db
      .updateTable("github_deploy_targets")
      .set({
        last_manifest: manifest,
        last_github_sha: deployment.github_sha,
        last_deployed_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", deployment.target_id)
      .execute();

    await db
      .updateTable("github_deployments")
      .set({
        status: "finalized",
        finalized_at: new Date(),
      })
      .where("id", "=", deployment.id)
      .execute();

    await purgeCloudflareFiles(deployment.login_name, [
      ...manifest.files.map((file) =>
        publicPath(deployment.target_prefix, file.path),
      ),
      ...deletedPaths.map((path) => publicPath(deployment.target_prefix, path)),
    ]);

    return {
      directorySize,
      deployedFiles: manifest.files.length,
      deletedFiles: deletedPaths.length,
    };
  } catch (error) {
    await db
      .updateTable("github_deployments")
      .set({
        status: "failed",
        error_message: error instanceof Error ? error.message : String(error),
      })
      .where("id", "=", deployment.id)
      .execute();
    throw error;
  }
}

export async function upsertGitHubDeployTarget(params: {
  user: UserRow;
  githubRepository: string;
  githubRef: string;
  targetPrefix?: string | null;
  deleteRemovedFiles?: boolean;
}) {
  const githubRepository = params.githubRepository.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository)) {
    throw new Error("GitHub repository must be in owner/repo format");
  }
  const githubRef = params.githubRef.trim();
  if (
    !githubRef.startsWith("refs/heads/") &&
    !githubRef.startsWith("refs/tags/")
  ) {
    throw new Error(
      "GitHub ref must be a full refs/heads/* or refs/tags/* ref",
    );
  }
  const targetPrefix = normalizeTargetPrefix(params.targetPrefix);
  const deleteRemovedFiles = params.deleteRemovedFiles ?? true;

  await db
    .insertInto("github_deploy_targets")
    .values({
      user_id: params.user.id,
      github_repository: githubRepository,
      github_ref: githubRef,
      target_prefix: targetPrefix,
      delete_removed_files: deleteRemovedFiles,
      enabled: true,
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc
        .columns([
          "user_id",
          "github_repository",
          "github_ref",
          "target_prefix",
        ])
        .doUpdateSet({
          delete_removed_files: deleteRemovedFiles,
          enabled: true,
          updated_at: new Date(),
        }),
    )
    .execute();
}
