import { redirect } from "next/navigation";
import { BadgeCheck } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { validateRequest } from "@/lib/auth";
import { getCustomDomainTarget } from "@/lib/customDomains";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import CustomDomainsCard from "../account/CustomDomainsCard";
import GitHubDeployTargetsCard from "../account/GitHubDeployTargetsCard";

export default async function SupportersPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect("/");
  }

  const [customDomainsEnabled, githubDeploysEnabled] = await Promise.all([
    userHasFeature(user.id, "custom_domains"),
    userHasFeature(user.id, "github_deploys"),
  ]);

  if (!customDomainsEnabled && !githubDeploysEnabled) {
    redirect("/account");
  }

  const customDomainRows = customDomainsEnabled
    ? await db
        .selectFrom("custom_domains")
        .select([
          "id",
          "hostname",
          "cloudflare_status",
          "ssl_status",
          "ownership_verification_name",
          "ownership_verification_type",
          "ownership_verification_value",
          "ssl_validation_records",
          "verification_errors",
          "verified_at",
        ])
        .where("user_id", "=", user.id)
        .orderBy("id", "desc")
        .execute()
    : [];
  const customDomains = customDomainRows.map((domain) => ({
    id: domain.id,
    hostname: domain.hostname,
    cloudflareStatus: domain.cloudflare_status,
    sslStatus: domain.ssl_status,
    ownershipVerificationName: domain.ownership_verification_name,
    ownershipVerificationType: domain.ownership_verification_type,
    ownershipVerificationValue: domain.ownership_verification_value,
    sslValidationRecords: domain.ssl_validation_records,
    verificationErrors: domain.verification_errors,
    verifiedAt: domain.verified_at?.toISOString() ?? null,
  }));

  const githubDeployTargetRows = githubDeploysEnabled
    ? await db
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
        .execute()
    : [];
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
      <div className="max-w-4xl mx-auto p-6 space-y-8">
        <Card className="bg-card border-2 border-border shadow-lg">
          <CardHeader className="bg-secondary border-b-2 border-border">
            <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
              <BadgeCheck size={20} />
              확장 기능
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6">
            <p className="text-muted-foreground text-base leading-relaxed">
              계정에 허용된 확장 기능을 설정하고 관리합니다.
            </p>
          </CardContent>
        </Card>

        {githubDeploysEnabled && (
          <GitHubDeployTargetsCard
            loginName={user.loginName}
            targets={githubDeployTargets}
          />
        )}
        {customDomainsEnabled && (
          <CustomDomainsCard
            enabled={customDomainsEnabled}
            domains={customDomains}
            target={getCustomDomainTarget()}
          />
        )}
      </div>
    </div>
  );
}
