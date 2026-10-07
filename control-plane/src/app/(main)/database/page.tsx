import { validateRequest } from "@/lib/auth";
import { redirect } from "next/navigation";
import DatabaseManager from "./DatabaseManager";
import { getHomepageUrl } from "@/lib/site-urls";
import { userHasFeature } from "@/lib/entitlements";

export default async function DatabasePage() {
  const { user } = await validateRequest();
  if (!user) redirect("/supporter");
  if (!(await userHasFeature(user.id, "database"))) redirect("/supporter");
  return (
    <DatabaseManager
      site={user.loginName}
      websiteUrl={`${getHomepageUrl(user.loginName)}/`}
    />
  );
}
