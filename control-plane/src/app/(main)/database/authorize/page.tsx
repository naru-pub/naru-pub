import { validateRequest } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { userHasFeature } from "@/lib/entitlements";
import {
  authorizationInput,
  authorizationSetup,
  previewAuthorization,
} from "@/lib/site-data/owner-auth";
import { DataError } from "@/lib/site-data/validation";
import Consent from "./Consent";
import Setup from "./Setup";

async function authorizationStep(userId: string, query: URLSearchParams) {
  const input = authorizationInput({
    ...Object.fromEntries(query),
    collections: query.get("collections")?.split(","),
  });
  // Setup the owner can finish here comes before consent, in its own step.
  const setup = await authorizationSetup(userId, input);
  if (setup) return { input, setup };
  return { input, preview: await previewAuthorization(userId, input) };
}

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
  if (!(await userHasFeature(user.id, "database"))) redirect("/account");
  // Only the loading is guarded: a component's render errors happen later and
  // belong to an error boundary, not this catch.
  let step: Awaited<ReturnType<typeof authorizationStep>>;
  try {
    step = await authorizationStep(user.id, query);
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
  if (step.setup)
    return <Setup input={step.input} setup={step.setup} />;
  const { client, collections } = step.preview;
  return (
    <Consent
      input={step.input}
      names={collections.map((c) => c.name)}
      tokenLifetimeSeconds={client.token_lifetime_seconds}
    />
  );
}
