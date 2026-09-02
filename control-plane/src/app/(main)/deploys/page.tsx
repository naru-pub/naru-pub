import { redirect } from "next/navigation";

import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import GitHubDeployTargetsCard from "../account/GitHubDeployTargetsCard";

export default async function DeploysPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect("/");
  }

  if (!(await userHasFeature(user.id, "github_deploys"))) {
    redirect("/account");
  }

  const githubDeployTargetRows = await db
    .selectFrom("github_deploy_targets")
    .select([
      "id",
      "github_repository",
      "github_ref",
      "target_prefix",
      "delete_removed_files",
      "enabled",
      "last_github_sha",
      "last_deployed_at",
    ])
    .where("user_id", "=", user.id)
    .where("enabled", "=", true)
    .orderBy("created_at", "desc")
    .execute();
  const githubDeployTargets = githubDeployTargetRows.map((target) => ({
    id: target.id,
    githubRepository: target.github_repository,
    githubRef: target.github_ref,
    targetPrefix: target.target_prefix,
    deleteRemovedFiles: target.delete_removed_files,
    enabled: target.enabled,
    lastGithubSha: target.last_github_sha,
    lastDeployedAt: target.last_deployed_at?.toISOString() ?? null,
  }));

  return (
    <div className="bg-background min-h-screen">
      <div className="mx-auto max-w-4xl space-y-8 p-6">
        <GitHubDeployTargetsCard
          loginName={user.loginName}
          targets={githubDeployTargets}
        />
      </div>
    </div>
  );
}
