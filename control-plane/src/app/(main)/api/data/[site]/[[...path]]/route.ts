import { dataRequest } from "@/lib/site-data/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ site: string; path?: string[] }> };
async function handle(request: Request, context: Context) {
  const { site, path } = await context.params;
  return dataRequest(request, path ?? [], site);
}
export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
  handle as OPTIONS,
};
