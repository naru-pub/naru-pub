import { validateRequest } from "@/lib/auth";
import { redirect } from "next/navigation";
import DatabaseManager from "./DatabaseManager";

export default async function DatabasePage() {
  const { user } = await validateRequest();
  if (!user) redirect("/login");
  return <DatabaseManager site={user.loginName} />;
}
