import { validateRequest } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  authorizationInput,
  previewAuthorization,
} from "@/lib/site-data/owner-auth";
import { DataError } from "@/lib/site-data/validation";
import Consent from "./Consent";

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // Reconstruct only recognized scalar fields. Never redirect to a supplied URL on error.
  const query = new URLSearchParams();
  for (const key of [
    "site",
    "clientId",
    "redirectUri",
    "challenge",
    "state",
    "collections",
  ]) {
    if (typeof params[key] === "string") query.set(key, params[key]);
  }
  const { user } = await validateRequest();
  if (!user)
    redirect(
      `/login?next=${encodeURIComponent(`/database/authorize?${query}`)}`,
    );
  try {
    const input = authorizationInput({
      ...Object.fromEntries(query),
      collections: query.get("collections")?.split(","),
    });
    const { client, collections } = await previewAuthorization(user.id, input);
    return (
      <Consent
        input={input}
        names={collections.map((c) => c.name)}
        tokenLifetimeSeconds={client.token_lifetime_seconds}
      />
    );
  } catch (error) {
    return (
      <div className="max-w-xl mx-auto p-6">
        <h1 className="text-xl font-bold">접근 요청을 확인할 수 없습니다</h1>
        <p role="alert">
          {error instanceof DataError
            ? error.message
            : "요청을 확인하지 못했습니다. 다시 시도해 주세요."}
        </p>
        <Link href="/database" className="underline">
          데이터베이스 설정으로 이동
        </Link>
      </div>
    );
  }
}
