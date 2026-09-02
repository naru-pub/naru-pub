import { redirect } from "next/navigation";

import { validateRequest } from "@/lib/auth";
import { getCustomDomainTarget } from "@/lib/customDomains";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import CustomDomainsCard from "../account/CustomDomainsCard";

export default async function DomainsPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect("/");
  }

  if (!(await userHasFeature(user.id, "custom_domains"))) {
    redirect("/account");
  }

  const customDomainRows = await db
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
    .execute();
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

  return (
    <div className="bg-background min-h-screen">
      <div className="mx-auto max-w-4xl space-y-8 p-6">
        <CustomDomainsCard
          enabled
          domains={customDomains}
          target={getCustomDomainTarget()}
        />
      </div>
    </div>
  );
}
