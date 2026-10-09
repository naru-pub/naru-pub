import type { Outcome, SiteData } from "./site";

export { SiteData } from "./site";

interface Env {
  SITES: DurableObjectNamespace<SiteData>;
  /** Shared with the control plane, which is this Worker's only caller. */
  SITE_DATA_WORKER_SECRET: string;
}

// POST /v1/sites/<site>/<operation> with a JSON body, answered with
// `{ value }` or `{ error: { status, message, code } }` at that status. The
// object is named by the site, so every request for a site meets the same one.
const OPERATIONS = [
  "execute",
  "batch",
  "collections",
  "createCollections",
  "freeze",
  "unfreeze",
  "export",
  "import",
  "erase",
] as const;
type Operation = (typeof OPERATIONS)[number];

// Site names, and the `compare:<site>` scratch objects of site-data-compare.
const SITE = /^(?:compare:)?[a-zA-Z0-9_-]{1,64}$/;

// A stub's methods are remote calls, so each is named rather than looked up.
function dispatch(
  stub: DurableObjectStub<SiteData>,
  operation: Operation,
  input: never,
) {
  switch (operation) {
    case "execute":
      return stub.execute(input);
    case "batch":
      return stub.batch(input);
    case "collections":
      return stub.collections(input);
    case "createCollections":
      return stub.createCollections(input);
    case "freeze":
      return stub.freeze();
    case "unfreeze":
      return stub.unfreeze();
    case "export":
      return stub.export();
    case "import":
      return stub.import(input);
    case "erase":
      return stub.erase();
  }
}

function failure(status: number, message: string) {
  return Response.json({ error: { status, message } }, { status });
}

async function authorized(request: Request, secret: string | undefined) {
  if (!secret) return false;
  const given = new TextEncoder().encode(
    request.headers.get("authorization") ?? "",
  );
  const expected = new TextEncoder().encode(`Bearer ${secret}`);
  return (
    given.byteLength === expected.byteLength &&
    crypto.subtle.timingSafeEqual(given, expected)
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!(await authorized(request, env.SITE_DATA_WORKER_SECRET)))
      return failure(401, "Unauthorized.");
    const match = /^\/v1\/sites\/([^/]+)\/([A-Za-z]+)$/.exec(
      new URL(request.url).pathname,
    );
    const site = match && decodeURIComponent(match[1]);
    const operation = match?.[2] as Operation | undefined;
    if (!site || !SITE.test(site) || !OPERATIONS.includes(operation!))
      return failure(404, "Not found.");
    if (request.method !== "POST") return failure(405, "Method not allowed.");
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return failure(400, "Expected a JSON body.");
    }
    const stub = env.SITES.get(env.SITES.idFromName(site));
    // Each operation takes one argument object; the object validates it.
    const outcome = (await dispatch(
      stub,
      operation!,
      input as never,
    )) as Outcome<unknown>;
    return outcome.ok
      ? // JSON drops `undefined`; the caller tells success by `value`.
        Response.json({ value: outcome.value ?? null })
      : Response.json(
          { error: outcome.error },
          { status: outcome.error.status },
        );
  },
} satisfies ExportedHandler<Env>;
