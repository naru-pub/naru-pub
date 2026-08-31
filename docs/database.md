# Site databases (Naru Data v1)

Naru Data stores per-site collections of JSON documents in the control plane's existing PostgreSQL database. Static sites use a dependency-free browser ES module; owners manage data and collection permissions at `/database` in the control plane. No Rust proxy changes or separate database hostname are required.

## Setup

From `control-plane`, install dependencies and run `pnpm migrate` against your intended development database before starting the app. For production, run the migration as part of the normal deployment procedure before serving the new API. The migrations add document storage, website registrations, authorization-code/token hashes, and rate-limit counters; they do not modify hosted files. The owner-auth migration preserves existing permissions. Reverting just that migration removes website authorization and converts `create` permissions to `admin` (fail closed). Back up PostgreSQL before production migrations. Do not roll back the migration unless you intend to delete all site databases.

For reverse-proxy deployments, owner request checks use `SITE_DATA_CONTROL_PLANE_ORIGIN` (an origin such as `https://naru.pub`). In production it defaults to `https://${NEXT_PUBLIC_DOMAIN}`, or `https://naru.pub` if unset. Configure it explicitly if the control plane uses another hostname. This avoids trusting forwarded host headers or comparing against Next's internal localhost URL. For local production-build tests, set it to the localhost origin used by the test client.

## Permissions

Every new collection defaults to `admin` read and `admin` write. Permissions are independent:

| Read  | Write  | Public behavior                                     |
| ----- | ------ | --------------------------------------------------- |
| admin | admin  | No document access.                                 |
| world | admin  | Read published blog posts.                          |
| world | create | Read and submit comments; cannot replace or delete. |
| admin | create | Submit private messages for owner review.           |
| admin | world  | Create, replace and delete, but not read.           |
| world | world  | Read, create, replace and delete.                   |

“Admin” means the authenticated Naru site owner, not another Naru user or a global platform administrator. Owners retain full document access. Only the control plane can create/delete collections or change permissions; website tokens cannot do so.

`create` allows only `POST /:collection` (`add` in the SDK), with a server-generated UUID. It does not allow `PUT`, even for a previously unused ID, or `DELETE`. Creation is insert-only and never overwrites an existing document. `world` writes remain unrestricted; use `create` for guestbooks and comments. Create-only does not moderate spam or allow visitors to edit their own submissions.

Keep drafts in an admin-readable collection. A `published: false` field does not hide a document inside a public-readable collection. For moderation, accept messages into an admin-readable/create-only `submissions` collection and publish approved entries into a public-readable/admin-writable `comments` collection.

Public API calls deliberately ignore cookies. SDK requests always use `credentials: "omit"`. An explicit owner bearer token grants scoped document access after Naru login; invalid or expired credentials never fall back to public access. Control-plane requests use the existing same-origin owner session. Never embed an owner session, password or fixed token in a public site.

## Browser SDK

Create a collection in the control plane, choose its permissions, then use this in a static page. Replace `https://naru.pub` with the control plane origin when running elsewhere. Custom-domain sites can use the same absolute import; both the SDK and public API support CORS.

```html
<script type="module">
  import {
    createDatabase,
    NaruDataError,
  } from "https://naru.pub/sdk/1.0.0/naru-data.js";
  const db = createDatabase({ site: "your-login-name" });
  const entries = db.collection("guestbook");

  try {
    const { id } = await entries.add({ name: "Visitor", message: "Hello!" });
    const document = await entries.get(id);
    // set() and delete() require owner access or full public write permission.
    const { documents, nextCursor } = await entries.list({ limit: 20 });
    if (nextCursor) {
      const nextPage = await entries.list({ limit: 20, after: nextCursor });
    }
  } catch (error) {
    if (error instanceof NaruDataError)
      console.error(error.status, error.message);
    else console.error(error);
  }
</script>
```

`get` returns `{ id, data, created_at, updated_at }`; a missing document throws a 404 error. `set` replaces the whole document or creates it if absent. `add` generates a UUID and returns only `{ id }`, without requiring read permission. `delete` is idempotent. JSON null is stored as a value, not treated as deletion. Render user data with `textContent`, not `innerHTML`.

SDK declarations are available alongside the module at `/sdk/1.0.0/naru-data.d.ts`. Set `baseUrl` explicitly if bundling/copying the SDK rather than importing it from the control plane.

## Website owner login

1. Open `/database` directly in the control plane (it is intentionally absent from the header).
2. Under website administrator login, register an exact callback URL such as `https://your-login-name.naru.pub/admin.html` and select the collections it may access. The callback must be on your Naru subdomain or an active, verified custom domain; no query, fragment, credentials, wildcard or arbitrary external origin. Development mode also permits loopback callbacks.
3. Copy the public Client ID into your editor page. This identifies the registration; it is not a secret.
4. Call `signInAsOwner()` from a button. Naru authenticates the owner and asks for explicit consent. The website resumes at the registered callback, where `completeOwnerSignIn()` returns a separate authenticated client.

Minimal editor-page wiring (replace site and Client ID):

```html
<meta name="referrer" content="no-referrer" />
<button id="login">Sign in to edit</button>
<button id="save" disabled>Publish example post</button>
<button id="logout" disabled>Sign out</button>
<p id="status"></p>
<script type="module">
  import { createDatabase } from "https://naru.pub/sdk/1.0.0/naru-data.js";
  const db = createDatabase({ site: "your-login-name" });
  const status = document.querySelector("#status");
  let admin = null;
  async function run(action) {
    try {
      await action();
    } catch (error) {
      status.textContent = error.message;
    }
  }
  await run(async () => {
    // Call early on the callback page; strips code/state before network access.
    admin = await db.completeOwnerSignIn();
  });
  document.querySelector("#save").disabled = !admin;
  document.querySelector("#logout").disabled = !admin;
  document.querySelector("#login").onclick = () =>
    run(() =>
      db.signInAsOwner({
        clientId: "YOUR-REGISTERED-CLIENT-ID",
        redirectUri: window.location.origin + window.location.pathname,
        collections: ["posts"],
      }),
    );
  document.querySelector("#save").onclick = () =>
    run(async () => {
      await admin
        .collection("posts")
        .set("hello", { title: "Hello", body: "My first post" });
      status.textContent = "Published";
    });
  document.querySelector("#logout").onclick = () =>
    run(async () => {
      const previous = admin;
      admin = null;
      document.querySelector("#save").disabled = true;
      document.querySelector("#logout").disabled = true;
      await previous.signOut();
      status.textContent = "Signed out";
    });
</script>
```

The requested collections must be a subset of the registration. The basic `db` remains public after signing in; only `admin` sends a bearer token. Tokens permit reading, creating, replacing and deleting documents in those collections, including private documents. They are tied to collection IDs so deleting and recreating a collection does not transfer old grants.

Authentication uses random state and mandatory S256 PKCE. The verifier and state live in tab-scoped sessionStorage for at most ten minutes; authorization codes expire after 60 seconds and are single-use, including concurrent exchanges. The server stores only code/token hashes. Access tokens expire after ten minutes and are kept only in SDK memory, never localStorage, cookies or URLs. Refresh tokens and popup login are not included. Reloading or token expiry requires sign-in again; errors are surfaced to the editor.

Owner session expiry/deletion, registration removal and token revocation are checked on subsequent requests. Domain ownership status is also rechecked. Use “revoke all login access” to invalidate a registration's outstanding codes and tokens, or remove the registration to disable future login. `admin.signOut()` drops the local token and requests server revocation; a network failure is reported and the server token can remain valid until expiry. This does not sign out of the Naru control plane.

Authorization approval and registration changes require same-origin owner requests. Token exchange and API access require the registered origin plus the explicit code/verifier or bearer token; CORS never grants authorization. The consent page disallows framing. An origin check cannot prevent use of a stolen bearer token by a non-browser client: scripts running on your editor page can exercise owner privileges while signed in. Use a minimal trusted editor without third-party scripts, avoid unsafe HTML rendering, and set a no-referrer policy on the callback page.

## SDK releases

Use `/sdk/1.0.0/naru-data.js` and matching `/sdk/1.0.0/naru-data.d.ts` declarations. **1.0.0 remains under active development and will continue to be updated until the project owner says otherwise.** Its responses use `no-cache` so browsers revalidate; it must not be treated as immutable.

Unversioned SDK URLs are not served. Existing `/sdk/naru-data.js` imports must be changed before deployment. There are no floating `latest` or major-version aliases. When release freezing is explicitly requested, adopt immutable full-version releases and semantic versioning for subsequent changes.

SDK versioning does not itself version the backend protocol. Version 1.0.0 uses `/api/data/:site`; preserve existing public CRUD behavior when extending it. Breaking server changes should introduce a separate API version.

## HTTP API

Public/website-token root: `/api/data/:site`. Control-plane root: `/api/account/database` (site derived from the session). Collection management is restricted to the control-plane root.

| Method | Path relative to root            | Body / result                                            |
| ------ | -------------------------------- | -------------------------------------------------------- |
| GET    | `/`                              | Admin only: `{ collections }`                            |
| POST   | `/`                              | Admin only: `{ name, read?, write? }` creates collection |
| PATCH  | `/:collection`                   | Admin only: `{ read, write }` replaces permissions       |
| DELETE | `/:collection`                   | Admin only: deletes collection and its documents         |
| GET    | `/:collection?limit=50&after=cursor` | `{ documents, nextCursor }`                              |
| POST   | `/:collection`                   | `{ data }` creates document; returns `{ id }`            |
| GET    | `/:collection/:id`               | `{ document }`                                           |
| PUT    | `/:collection/:id`               | `{ data }` replaces document; returns `{ id }`           |
| DELETE | `/:collection/:id`               | `{ success: true }`                                      |

All JSON request bodies require `Content-Type: application/json`. Errors return `{ error }` with an HTTP status (400 invalid input, 401 no admin session, 403 denied, 404 missing, 409 duplicate/quota, 413 oversized, 415 wrong content type, 429 rate limit). Public preflight needs no authentication. Responses are not cached.

Owner authorization endpoints:

| Endpoint                                     | Purpose                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /database/authorize`                    | Login/consent UI; never issues a code on GET.                                                                                           |
| `POST /api/data-auth/authorize`              | Same-origin owner approval with `clientId`, `site`, `redirectUri`, `challenge`, `state`, `collections`; returns validated redirect URL. |
| `POST /api/data-auth/token`                  | Exchange JSON `{ code, verifier, clientId, redirectUri }` from the registered Origin; returns `{ accessToken, tokenType, expiresIn }`.  |
| `POST /api/data-auth/revoke`                 | Revoke the bearer token supplied in Authorization; requires its registered Origin.                                                      |
| `GET/POST /api/account/database-clients`     | Same-origin owner registration listing/creation (`{ redirectUri, collections }`).                                                       |
| `PATCH/DELETE /api/account/database-clients` | Same-origin owner revoke-all/remove registration (`{ id }`).                                                                            |

There are at most 20 registrations per site, 20 pending codes and 50 live tokens per registration. Expired grants are cleaned during authorization activity. Removing registrations/accounts/sessions cascades into their grants.

## Limits and consistency

- 100 collections, 10,000 documents, and 10 MiB of serialized JSON per site, separate from the hosted-file quota.
- Maximum request body: 64 KiB, including the `{ data }` envelope; enforced while streaming, even without Content-Length.
- Collection names and document IDs: 1–64 ASCII letters, numbers, underscores or hyphens.
- Pages: 1–100 documents (default 50), defaulting to ID ascending under the database collation. See sorting below; pagination is not a snapshot across concurrent changes.
- PostgreSQL JSONB semantics apply, including JavaScript number precision and no significant object key order.
- Owner-row locks serialize permission checks, writes, and quota checks across server processes. Deletes free quota; account deletion cascades through collections and documents.
- Replacements are atomic and last-write-wins; creates are insert-only. No realtime subscriptions, offline persistence, custom indexes/queries, compare-and-set, SDK transactions, per-document rules or visitor accounts in v1.

Public access intentionally permits callers from any origin. Public creates use database-backed fixed-minute limits of 60 successful creates per site and 20 per caller/IP per site, shared across collections and server processes. Owner writes do not consume these limits. Failed writes roll back their counters.

By default, callers share an `unknown` bucket (20/minute/site). Set `SITE_DATA_TRUST_CLOUDFLARE_IP=1` **only** when a trusted Cloudflare ingress replaces `CF-Connecting-IP` and direct access to the application is blocked. Otherwise clients can spoof the header to evade IP limits. With that setting, valid IPs get separate buckets while invalid/missing headers still share `unknown`. Only a digest is stored in the bucket key; it is not guaranteed anonymization. Old buckets are removed on the next create for that site.

These limits do not protect reads, full-public replacements/deletes, invalid requests or authorization endpoints from high request volumes. Configure edge rate/body limits for `/api/data/*` and `/api/data-auth/*` as well. PostgreSQL backups must include these new tables; the existing hosted-file export does not include database records.

## Tests

```sh
cd control-plane
pnpm exec tsc --noEmit
pnpm exec jest --config jest.data.config.cjs --runInBand
node --test tests/naru-data-sdk.test.mjs
# Disposable local PostgreSQL database only; tests create/drop tables:
NARU_DATA_TEST=1 DATABASE_URL=postgresql://localhost/naru_data_test \
  pnpm exec jest --config jest.data.config.cjs --runInBand
```

Integration tests require an empty database named exactly `naru_data_test`. They cover all permission combinations, create-only restrictions, rate/quota races, PKCE, single-use codes, token scope, expiry, revocation, domain validation and session/registration deletion. HTTP tests cover cookie isolation, same-origin admin protection, authentication and preflight; SDK tests cover CRUD transport and errors. The dedicated Jest config avoids obsolete global Lucia and Request mocks in the existing test setup.

## Public guide and example

The Korean guide is served publicly at `/database/docs/`. The control panel links to it without adding a global header link. The static blog example lives in `control-plane/public/examples/database-blog/`; `/database/docs/blog.zip` packages these same source files at build time. See its README for installation and permission setup.

## Server-side sorting and pagination (SDK 1.0.0)

```js
const posts = db.collection("posts");
const sort = { orderBy: "created_at", direction: "desc" };
const page = await posts.list({ ...sort, limit: 20 });
if (page.nextCursor !== null) {
  const next = await posts.list({ ...sort, limit: 20, after: page.nextCursor });
}
```

`orderBy`: `id` (default), `created_at`, or `updated_at`. `direction`: `asc` (default) or `desc`. These are server metadata, not JSON fields. Arbitrary JSON-field sorting and filters are not supported. Timestamp ties use document ID in the same direction. Both timestamp orders have composite collection/time/ID indexes.

`get` and `list` return `created_at` as well as `updated_at`. Creation time is assigned by the server, preserved on replacement, and cannot be changed by fields in `data`. The new migration backfills existing documents from their recorded `updated_at`; their original creation time is unknown.

Pass `nextCursor` unchanged as `after` with the same collection, orderBy, and direction. Cursors preserve PostgreSQL timestamp precision and the last ID, and remain usable after that document is deleted. They are bound to the collection's internal ID (including across deletion/recreation), field, and direction; mismatches and malformed cursors return 400. They are not credentials: read permissions are checked on every request. Legacy raw ID cursors are accepted only for ID ascending, but all new responses return opaque cursors. Changing page size is allowed.

A null cursor marks the end. Cache prior pages or their starting cursors for a Previous button. There are no page numbers, offsets or total counts. Reset the cursor and displayed results when switching sort order. Pagination is not a snapshot: newly inserted records before the cursor require a refresh; changing a sort value during traversal can skip or repeat a record. Prefer immutable `created_at` for feeds. The example uses newest-first server creation time for both posts and guestbook entries.
