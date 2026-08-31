import { ownerAuthRequest } from "@/lib/site-data/auth-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = (request: Request) => ownerAuthRequest(request, "clients");
export { handle as GET, handle as POST, handle as DELETE, handle as PATCH };
