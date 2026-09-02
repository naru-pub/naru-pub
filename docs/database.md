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

SDK declarations are available alongside the module at `/sdk/1.0.0/naru-data.d.ts`. The SDK pins `https://naru.pub` as its control-plane origin, even when bundled/copied. There is no `baseUrl` or example `controlPlaneOrigin` configuration.

## Website owner login

1. Open `/database` directly in the control plane (it is intentionally absent from the header).
2. Under website administrator login, register an exact callback URL such as `https://your-login-name.naru.pub/admin.html` and select the collections it may access. The callback must be on your Naru subdomain or an active, verified custom domain; no query, fragment, credentials, wildcard or arbitrary external origin. Development mode also permits loopback callbacks.
3. The SDK discovers the site's stable public Client ID from the exact registered callback URL. Applications no longer need to copy it into configuration. Each callback keeps independent collection permissions.
4. Call `signInAsOwner()` from a button. Naru authenticates the owner and asks for explicit consent. The website resumes at the registered callback, where `completeOwnerSignIn()` returns a separate authenticated client.

Minimal editor-page wiring (replace the site login name):

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

The SDK discovers the site's public Client ID from the exact registered callback URL. The requested collections must be a subset of the registration. The basic `db` remains public after signing in; only `admin` sends a bearer token. Tokens permit reading, creating, replacing and deleting documents in those collections, including private documents. They are tied to collection IDs so deleting and recreating a collection does not transfer old grants.

Authentication uses random state and mandatory S256 PKCE. The verifier and state live in tab-scoped sessionStorage for at most ten minutes; authorization codes expire after 60 seconds and are single-use, including concurrent exchanges. The server stores only code/token hashes. Each registered admin page has a control-plane token lifetime of 1-1440 whole minutes (default 1440). Each sign-in issues one opaque admin token capped by this setting, the duration displayed at consent, and the approving Naru session. The platform maximum remains 24 hours. The SDK stores it in sessionStorage under the site and exact callback. `completeOwnerSignIn()` restores it locally on reload without a network request; each subsequent data request rechecks authorization on the server. Neither reloads nor requests extend the original expiration. There are no refresh tokens or automatic renewals.

Control-plane session expiry/deletion, registration removal, token revocation, and domain status are checked on every authenticated data request. Use the control panel to revoke a page's outstanding codes and tokens, or remove its registration to disable future login. `admin.signOut()` clears local credentials before requesting server revocation. A network failure is reported; a copied token may remain usable until revoked or its 24-hour deadline. This does not sign out of the Naru control plane. Browser session restoration can restore sessionStorage, so use explicit logout to end access. The token is accessible to same-origin JavaScript: URL paths are not security isolation boundaries. Never share it or load untrusted scripts. A stolen token can be used longer than a short-lived access token unless revoked.

Authorization approval and registration changes require same-origin owner requests. Token exchange and API access require the registered origin plus the explicit code/verifier or bearer token; CORS never grants authorization. The consent page disallows framing. An origin check cannot prevent use of a stolen bearer token by a non-browser client: scripts running on your editor page can exercise owner privileges while signed in. Use a minimal trusted editor without third-party scripts, avoid unsafe HTML rendering, and set a no-referrer policy on the callback page.

## SDK releases

Use `/sdk/1.0.0/naru-data.js` and matching `/sdk/1.0.0/naru-data.d.ts` declarations. **1.0.0 remains under active development and will continue to be updated until the project owner says otherwise.** Its responses use `no-cache` so browsers revalidate; it must not be treated as immutable.

Unversioned SDK URLs are not served. Existing `/sdk/naru-data.js` imports must be changed before deployment. There are no floating `latest` or major-version aliases. When release freezing is explicitly requested, adopt immutable full-version releases and semantic versioning for subsequent changes.

SDK versioning does not itself version the backend protocol. Version 1.0.0 uses `/api/data/:site`; preserve existing public CRUD behavior when extending it. Breaking server changes should introduce a separate API version.

SDK 1.0.0 supports synchronous write validators through `schemas`, atomic owner writes through `owner.batch()`, upload progress/cancellation, and file metadata. A development control-plane override is accepted only for HTTP loopback origins:

```js
const db = createDatabase({
  site: "your-login-name",
  controlPlaneOrigin: "http://localhost:3000",
  schemas: {
    posts: (post) => typeof post?.title === "string" && post.title.length > 0,
  },
});

await owner.batch([
  { type: "set", collection: "posts", id: "hello", data: post },
  { type: "delete", collection: "drafts", id: "hello" },
]);
```

Schema validators run before requests and are developer feedback, not a security boundary. Batch operations commit in one server transaction. `NaruDataError.code` provides stable codes including `UNREGISTERED_REDIRECT_URI`, `COLLECTION_NOT_AUTHORIZED`, and `OWNER_SESSION_EXPIRED`.

## HTTP API

Public/website-token root: `/api/data/:site`. Control-plane root: `/api/account/database` (site derived from the session). Collection management is restricted to the control-plane root.

| Method | Path relative to root                | Body / result                                             |
| ------ | ------------------------------------ | --------------------------------------------------------- |
| GET    | `/`                                  | Admin only: `{ collections }`                             |
| POST   | `/`                                  | Admin only: `{ name, read?, write? }` creates collection  |
| PATCH  | `/:collection`                       | Admin only: `{ read, write }` replaces permissions        |
| DELETE | `/:collection`                       | Admin only: deletes collection and its documents          |
| GET    | `/:collection?limit=50&after=cursor` | `{ documents, nextCursor }`                               |
| POST   | `/:collection`                       | `{ data }` creates document; returns `{ id }`             |
| GET    | `/:collection/:id`                   | `{ document }`                                            |
| PUT    | `/:collection/:id`                   | `{ data }` replaces document; returns `{ id }`            |
| DELETE | `/:collection/:id`                   | `{ success: true }`                                       |
| POST   | `/_batch`                            | Owner-only atomic `{ operations }`; returns `{ results }` |

All JSON request bodies require `Content-Type: application/json`. Errors return `{ error }` with an HTTP status (400 invalid input, 401 no admin session, 403 denied, 404 missing, 409 duplicate/quota, 413 oversized, 415 wrong content type, 429 rate limit). Public preflight needs no authentication. Responses are not cached.

Owner authorization endpoints:

| Endpoint                                     | Purpose                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /database/authorize`                    | Login/consent UI; never issues a code on GET.                                                                                                     |
| `GET /api/data-auth/discover`                | Discovers the public site Client ID for an exact registered callback and matching Origin.                                                         |
| `POST /api/data-auth/authorize`              | Same-origin owner approval with `clientId`, `site`, `redirectUri`, `challenge`, `state`, `collections`; returns validated redirect URL.           |
| `POST /api/data-auth/token`                  | Exchange JSON `{ code, verifier, clientId, redirectUri }` from the registered Origin; returns `{ accessToken, tokenType, expiresIn, expiresAt }`. |
| `POST /api/data-auth/revoke`                 | Revoke the bearer token supplied in Authorization; requires its registered Origin.                                                                |
| `GET/POST /api/account/database-clients`     | Same-origin owner registration listing/creation (`{ redirectUri, collections }`).                                                                 |
| `PATCH/DELETE /api/account/database-clients` | Same-origin owner revoke-all/remove registration (`{ id }`).                                                                                      |

There are at most 20 registrations per site, 20 pending codes and 50 live tokens per registration. Expired grants are cleaned during authorization activity. Removing registrations/accounts/sessions cascades into their grants.

## Limits and consistency

- 100 collections, 10,000 documents, and 10 MiB of serialized JSON per site, separate from the hosted-file quota.
- Maximum request body: 64 KiB, including the `{ data }` envelope; enforced while streaming, even without Content-Length.
- Collection names and document IDs: 1–64 ASCII letters, numbers, underscores or hyphens.
- Pages: 1–100 documents (default 50), defaulting to ID ascending under the database collation. See sorting below; pagination is not a snapshot across concurrent changes.
- PostgreSQL JSONB semantics apply, including JavaScript number precision and no significant object key order.
- Owner-row locks serialize permission checks, writes, and quota checks across server processes. Deletes free quota; account deletion cascades through collections and documents.
- Replacements and `owner.batch()` writes are atomic and last-write-wins; creates are insert-only. No realtime subscriptions, offline persistence, custom indexes or arbitrary query expressions, compare-and-set, per-document rules or visitor accounts in v1.

## File uploads (SDK 1.0.0)

Owner sessions can upload files directly to the `naru-media` R2 bucket. The SDK
obtains a ten-minute signed upload URL, sends the bytes directly to R2, and asks
Naru to verify the stored size and content type before returning a ready file.
Database documents should store `file.id` or `file.url`, not base64 data.

```js
const image = await owner.files.upload(fileInput.files[0], {
  signal: abortController.signal,
  onProgress: ({ loaded, total }) => showProgress(loaded / total),
  metadata: {
    altText: "A pigeon",
    references: [{ collection: "posts", id: "hello" }],
  },
});
await owner.collection("posts").set("hello", {
  title: "Hello",
  coverImage: image.url,
});

const files = await owner.files.list();
await owner.files.delete(image.id);
```

사이트 소유자는 **미디어 라이브러리**(`/media`)에서 파일을 끌어
놓아 업로드하고, 저장 공간을 확인하고, 이름·형식으로 검색하거나 정렬하고, 공개
URL을 복사하고, 파일을 삭제할 수 있습니다. 삭제 전에 해당 URL을 사용하는 문서를
직접 확인해야 합니다.

Uploads are owner-only and use the same tab-scoped website bearer token as
document writes. Each file is limited to 25 MiB; each site is limited to 1,000
files and 250 MiB. JPEG, PNG, WebP, AVIF, GIF, supported audio, PDF, ZIP, and
plain text are accepted. HTML and SVG are rejected. Public objects are served
from the separately isolated `media.naru.pub` origin. Deleting a file removes
both the R2 object and its metadata; deleting an account removes its media
prefix. Upload callers should keep the returned ID so unused objects can be
deleted explicitly. Upload authorizations that are not finalized are removed by
the background cleanup after one hour.

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

`orderBy`: `id` (default), `created_at`, or `updated_at`. `direction`: `asc` (default) or `desc`. These are server metadata, not JSON fields. Arbitrary JSON-field sorting is not supported; scalar equality filters are supported as described below. Timestamp ties use document ID in the same direction. Both timestamp orders have composite collection/time/ID indexes.

`get` and `list` return `created_at` as well as `updated_at`. Creation time is assigned by the server, preserved on replacement, and cannot be changed by fields in `data`. The new migration backfills existing documents from their recorded `updated_at`; their original creation time is unknown.

Pass `nextCursor` unchanged as `after` with the same collection, orderBy, direction, and filters. Cursors preserve PostgreSQL timestamp precision and the last ID, and remain usable after that document is deleted. They are bound to the collection's internal ID (including across deletion/recreation), field, direction, and canonical filter fingerprint; mismatches and malformed cursors return 400. They are not credentials: read permissions are checked on every request. Legacy raw ID cursors are accepted only for unfiltered ID ascending, but all new responses return opaque cursors. Changing page size is allowed.

A null cursor marks the end. Cache prior pages or their starting cursors for a Previous button. There are no page numbers, offsets or total counts. Reset the cursor and displayed results when switching sort order or filters. Pagination is not a snapshot: newly inserted records before the cursor require a refresh; changing a sort value during traversal can skip or repeat a record. Prefer immutable `created_at` for feeds. The example uses newest-first server creation time for both posts and guestbook entries.

## Equality filters and automatic indexes

```js
const query = {
  where: { category: "일상", active: true },
  orderBy: "created_at",
  direction: "desc",
  limit: 20,
};
const page = await db.collection("posts").list(query);
if (page.nextCursor) {
  const next = await db
    .collection("posts")
    .list({ ...query, after: page.nextCursor });
}
```

HTTP: `GET /api/data/:site/:collection?where=<URL-encoded JSON object>&orderBy=created_at&direction=desc`. The account API accepts the same parameters. `where` applies only to collection list requests. At most 5 top-level field equalities are ANDed. Field names use the same 1–64 ASCII alphanumeric/underscore/hyphen rules as document IDs. Values are JSON strings, finite numbers, booleans or null. The decoded filter JSON is limited to 2,048 UTF-8 bytes. Absent `where` and `{}` mean no filtering.

Types match exactly: number 1 differs from string "1"; null matches an explicit null field, not an absent field. Strings match case-sensitively. Arrays/objects do not match scalars. No nested paths, array membership, ranges, OR, substring search, or arbitrary JSON-field sorting. Filters are carried in URLs; do not put secrets in them.

A shared PostgreSQL GIN `jsonb_path_ops` index automatically supports containment candidate lookup; exact per-field JSONB comparisons enforce scalar equality semantics. Existing collection/ID and collection/time/ID indexes support tenant narrowing and ordering. PostgreSQL chooses its execution plan based on selectivity; an index does not guarantee every query avoids scanning. No user-managed index configuration is needed. The new index migration creates no new document data and its rollback only drops the index. Index creation can block writes while building; schedule production migration accordingly for large databases.

Opaque cursors include a SHA-256 fingerprint of normalized filters. Reordering equivalent keys works; changing, adding or dropping a filter invalidates the cursor. Read permissions and owner scopes are checked on each page. Filters are not authorization: publicly readable collections remain readable without filters.

## Extended blog example

Create `posts` (world/admin), `guestbook` (world/create), and **`drafts` (admin/admin)**. Register the callback with `posts` and `drafts`. Edit the existing callback in the control plane to include both collections; its grants are revoked immediately but its Client ID remains valid. New pages use the shared website Client ID. When upgrading from callback-specific IDs, replace them once with the shared website Client ID and sign in again.

The public list filters by exact `category`. The editor loads paginated posts/drafts, edits documents while preserving other JSON fields, saves private drafts, publishes, and deletes the selected document after confirmation. Local tab storage preserves the editor through the login redirect; explicit server draft saving persists across sessions. Signing out clears the editor and local draft.

Draft and public copies share an ID. Saving a private draft does not unpublish or change an existing public post. Publication uses `owner.batch()` to write the post and remove its draft atomically; failure preserves the draft and leaves the public post unchanged. Deletion affects only the selected collection. There is no conflict detection: concurrent editors use last-write-wins. Guestbook moderation remains in the control panel.

### Website identity and admin tokens

`site_data_site_clients` stores one persistent ID per owner, independently of callback rows. Migration preserves callback rows as internal registration IDs, but invalidates all existing authorization codes and website access tokens. Old callback IDs are not accepted as public Client IDs. Each registered page retains its exact callback and collection IDs. Changing a callback URL or its collection permissions revokes all of its codes and access tokens, including when widening scope. Reducing its token lifetime also revokes them. Increasing only the lifetime preserves existing tokens with their original deadlines; pending codes retain the duration already approved. Saving an unchanged registration does not revoke access. Removing a callback cascades the same revocation; the website ID survives even when the last callback is removed.

Every `/api/data-auth/token` exchange returns `{accessToken, tokenType: "Bearer", expiresIn, expiresAt}`. `expiresAt` is the fixed expiry in Unix milliseconds; the token lasts no longer than the configured page lifetime, consented duration, platform maximum, or approving Naru session, whichever ends first. `POST /api/data-auth/revoke` takes the bearer token and revokes it idempotently. The unpublished renewal tables and `/refresh` and `/end-session` endpoints have been removed; the existing access-token table is sufficient. Requests use explicit credentials and never ambient cookies.

### Configuring token lifetime

In the control plane, create or edit a registered admin page and set its token lifetime in minutes (1-1440, default 1440). The account registration API accepts `tokenLifetimeSeconds` as a whole-minute integer in seconds, from 60 through 86400. Existing registrations and outstanding codes migrate with a default of 86400; existing token deadlines are preserved. `PATCH /api/account/database-clients` can update only `{id, tokenLifetimeSeconds}`. Omitting this field preserves the current lifetime. Other users and website bearer tokens cannot change it. Database constraints enforce the range as well as application validation.

Consent displays the configured duration and submits that displayed value. Approval binds the smaller of the current registration limit and the displayed duration to the one-use code; exchange cannot widen it with an SDK argument or a concurrent settings increase. Shortening a registration revokes pending codes as well as issued tokens. Rollback revokes outstanding grants before returning to the old fixed-lifetime behavior.

### SDK 1.0.0 data and error contract

`collection<Post>("posts")` types reads, lists, and complete replacement writes.
Types describe the application's schema; they do not validate server responses at runtime.

Writes accept JSON primitives, dense arrays, and plain objects. The SDK rejects
undefined, non-finite numbers, BigInt, functions, symbols, cycles, sparse arrays,
getters, non-enumerable properties, and class instances. Convert dates to strings
explicitly. `set()` replaces the entire document rather than merging fields.

HTTP failures throw `NaruDataError` with the original `status`, including non-JSON
proxy responses. Network failures use `status: 0` and preserve `cause`. Invalid
JSON or primitive success responses also throw `NaruDataError`, retaining the
HTTP status (which can be 200). Invalid caller data throws `TypeError`.

There are no automatic retries. A failed or interrupted response does not prove
that a write failed: retrying `add()` can create another document. Read back or
reconcile before retrying. Cursor pagination is not a snapshot: concurrent edits
can move records between pages, especially when sorting by `updated_at`.
