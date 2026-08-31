import { ownerAuthRequest } from "@/lib/site-data/auth-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  const { action } = await context.params;
  // Client registrations are available only through the same-origin account route.
  return ownerAuthRequest(
    request,
    ["authorize", "token", "revoke"].includes(action) ? action : "missing",
  );
}
export { handle as POST, handle as OPTIONS };
