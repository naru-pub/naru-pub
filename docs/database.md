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

Create a collection in the control plane, choose its permissions, then use this in a static page. The database and its collections are created in the control plane; a page only names them. Both the SDK and the public API support CORS.

```html
<script type="module">
  import {
    collection,
    NaruDataError,
  } from "https://naru.pub/sdk/1.0.0/naru-data.js";
  const entries = collection("guestbook");

  try {
    const { id } = await entries.add({ name: "Visitor", message: "Hello!" });
    const document = await entries.get(id);
    // set() and delete() require owner access or full public write permission.
    let pageToken = null;
    do {
      const page = await entries.list({ limit: 20, pageToken });
      render(page.documents);
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (error) {
    if (error instanceof NaruDataError)
      console.error(error.status, error.code, error.message);
    else throw error;
  }
</script>
```

A page served from `<login>.naru.pub` belongs to that site, so `collection(name)` needs nothing else. A custom domain or local page passes `collection(name, { site: "login-name" })`, and the same `{ site }` goes to `signIn` and `ownerSession`.

`get` returns `{ id, data, version, createdAt, updatedAt }`; a missing document throws a 404 error. `set` replaces the whole document or creates it if absent. `add` generates a UUID, without requiring read permission. `add` and `set` return `{ id, version, createdAt, updatedAt }`, so a caller rendering what it just saved uses the server's own timestamps rather than the browser clock. `delete` is idempotent and resolves with nothing. JSON null is stored as a value, not treated as deletion. Render user data with `textContent`, not `innerHTML`.

SDK declarations are available alongside the module at `/sdk/1.0.0/naru-data.d.ts`. The SDK pins `https://naru.pub` as its control-plane origin, even when bundled/copied; `controlPlaneOrigin` accepts only HTTP loopback origins, for development.

## Website owner login

1. Open `/database` directly in the control plane (it is intentionally absent from the header).
2. Under website administrator login, register an exact callback URL such as `https://your-login-name.naru.pub/admin.html` and select the collections it may access. The callback must be on your Naru subdomain or an active, verified custom domain; no query, fragment, credentials, wildcard or arbitrary external origin. Development mode also permits loopback callbacks.
3. The SDK discovers the site's stable public Client ID from the exact registered callback URL. Applications no longer need to copy it into configuration. Each callback keeps independent collection permissions.
4. Call `signIn({ collections })` from a button. Naru authenticates the owner and asks for explicit consent. The website resumes at the page that called it, which must be the registered callback, where `ownerSession()` returns a separate authenticated client.

Minimal editor-page wiring:

```html
<meta name="referrer" content="no-referrer" />
<button id="login">Sign in to edit</button>
<button id="save" disabled>Publish example post</button>
<button id="logout" disabled>Sign out</button>
<p id="status"></p>
<script type="module">
  import {
    ownerSession,
    signIn,
  } from "https://naru.pub/sdk/1.0.0/naru-data.js";
  const status = document.querySelector("#status");
  async function run(action) {
    try {
      await action();
    } catch (error) {
      if (error.code === "OWNER_SESSION_EXPIRED") owner = null;
      status.textContent = error.message;
    }
  }
  // Call early on the callback page: it strips code/state from the address.
  let owner = await ownerSession();
  document.querySelector("#save").disabled = !owner;
  document.querySelector("#logout").disabled = !owner;
  document.querySelector("#login").onclick = () =>
    run(() => signIn({ collections: ["posts"] }));
  document.querySelector("#save").onclick = () =>
    run(async () => {
      await owner
        .collection("posts")
        .set("hello", { title: "Hello", body: "My first post" });
      status.textContent = "Published";
    });
  document.querySelector("#logout").onclick = () =>
    run(async () => {
      const previous = owner;
      owner = null;
      document.querySelector("#save").disabled = true;
      document.querySelector("#logout").disabled = true;
      await previous.signOut();
      status.textContent = "Signed out";
    });
</script>
```

The SDK discovers the site's public Client ID from the exact registered callback URL. The requested collections must be a subset of the registration. Handles from `collection()` stay public after signing in; only `owner.collection()` sends a bearer token. Tokens permit reading, creating, replacing and deleting documents in those collections, including private documents. They are tied to collection IDs so deleting and recreating a collection does not transfer old grants.

Authentication uses random state and mandatory S256 PKCE. The verifier and state live in tab-scoped sessionStorage for at most ten minutes; authorization codes expire after 60 seconds and are single-use, including concurrent exchanges. The server stores only code/token hashes. Each registered admin page has a control-plane token lifetime of 1-1440 whole minutes (default 1440). Each sign-in issues one opaque admin token capped by this setting, the duration displayed at consent, and the approving Naru session. The platform maximum remains 24 hours. The SDK stores it in sessionStorage under the site and exact callback. `ownerSession()` restores it locally on reload without a network request; each subsequent data request rechecks authorization on the server. Neither reloads nor requests extend the original expiration. There are no refresh tokens or automatic renewals.

Control-plane session expiry/deletion, registration removal, token revocation, and domain status are checked on every authenticated data request. Use the control panel to revoke a page's outstanding codes and tokens, or remove its registration to disable future login. `owner.signOut()` clears local credentials before requesting server revocation. Once `owner.expiresAt` passes, or the server answers 401, owner requests fail with `OWNER_SESSION_EXPIRED` and the stored session is cleared, so the next `ownerSession()` returns null. A network failure is reported; a copied token may remain usable until revoked or its 24-hour deadline. This does not sign out of the Naru control plane. Browser session restoration can restore sessionStorage, so use explicit logout to end access. The token is accessible to same-origin JavaScript: URL paths are not security isolation boundaries. Never share it or load untrusted scripts. A stolen token can be used longer than a short-lived access token unless revoked.

Authorization approval and registration changes require same-origin owner requests. Token exchange and API access require the registered origin plus the explicit code/verifier or bearer token; CORS never grants authorization. The consent page disallows framing. An origin check cannot prevent use of a stolen bearer token by a non-browser client: scripts running on your editor page can exercise owner privileges while signed in. Use a minimal trusted editor without third-party scripts, avoid unsafe HTML rendering, and set a no-referrer policy on the callback page.

## SDK releases

Use `/sdk/1.0.0/naru-data.js` and matching `/sdk/1.0.0/naru-data.d.ts` declarations. **1.0.0 remains under active development and will continue to be updated until the project owner says otherwise.** Its responses use `no-cache` so browsers revalidate; it must not be treated as immutable.

Unversioned SDK URLs are not served. Existing `/sdk/naru-data.js` imports must be changed before deployment. There are no floating `latest` or major-version aliases. When release freezing is explicitly requested, adopt immutable full-version releases and semantic versioning for subsequent changes.

SDK versioning does not itself version the backend protocol. Version 1.0.0 uses `/api/data/:site`; preserve existing public CRUD behavior when extending it. Breaking server changes should introduce a separate API version.

The 1.0.0 SDK is deliberately small, because every option it sends is a contract the server has to keep. Its whole surface is `collection()` with `get`, `list`, `add`, `set` and `delete`; `signIn()`; `ownerSession()` returning `expiresAt`, `collection()`, `batch()`, `files.upload / list / delete` and `signOut()`; and `NaruDataError`. Features are added when a site needs them, not in advance.

During 1.0.0 development the SDK dropped `createDatabase`, per-collection `parse`/`map`, `schemas`, `update` merge patches and `unset`, `count()`, `all()`, string `orderBy` with `direction`, `fresh`, `timeoutMs`, `createRequestChannel`, session events, client-side request and response validation, upload progress, image tuning options, and the file `get`, `update` and `usage` methods. The server removed the matching endpoints and parameters.

## HTTP API

Public/website-token root: `/api/data/:site`. Control-plane root: `/api/account/database` (site derived from the session). Collection management is restricted to the control-plane root.

| Method | Path relative to root                   | Body / result                                                       |
| ------ | --------------------------------------- | ------------------------------------------------------------------- |
| GET    | `/`                                     | Admin only: `{ collections }`                                       |
| POST   | `/`                                     | Admin only: `{ name, read?, write? }` creates collection            |
| PATCH  | `/:collection`                          | Control panel only: `{ read, write }` replaces permissions          |
| DELETE | `/:collection`                          | Admin only: deletes collection and its documents                    |
| GET    | `/:collection?limit=50&pageToken=token` | `{ documents, nextPageToken, total? }`; accepts sorting and filters |
| POST   | `/:collection`                          | `{ data }` creates document; returns the write result               |
| GET    | `/:collection/:id`                      | `{ document }`                                                      |
| PUT    | `/:collection/:id?ifVersion=`           | `{ data }` replaces document; returns the write result              |
| DELETE | `/:collection/:id?ifVersion=`           | `{ success: true }`                                                 |
| POST   | `/_batch`                               | Owner-only atomic `{ operations }`; returns `{ results }`           |
| GET    | `/_files?limit=50&pageToken=&where=`    | Owner-only `{ files, nextPageToken }`, newest first                 |
| GET    | `/_files?usage=1`                       | Control panel only: `{ usage }`                                     |
| POST   | `/_files`                               | Owner-only upload authorization                                     |
| PUT    | `/_files/:id`                           | Owner-only finalize; verifies the stored bytes                      |
| DELETE | `/_files/:id`                           | `{ success: true }`                                                 |

A write result is `{ id, version, createdAt, updatedAt }`; `_batch` accepts `add`, `set` and `delete` operations and returns one result per operation in order, with `{ success: true }` for deletes. A list accepts `where` (URL-encoded JSON), `orderBy` (URL-encoded JSON array of one or two `[field, direction]` pairs), `limit`, `pageToken` and `includeTotal=1`. `/_files` accepts `limit`, `pageToken` and `where`, which filters the file's `metadata`; it always lists newest first. The public route does not accept `PATCH`.

All JSON request bodies require `Content-Type: application/json`. Errors return `{ error }` with an HTTP status (400 invalid input, 401 no admin session, 403 denied, 404 missing, 405 unsupported method, 409 duplicate/quota/conflict, 413 oversized, 415 wrong content type, 429 rate limit). Public preflight needs no authentication. Errors, writes, and authenticated reads are not cached; anonymous reads from `world`-readable collections may use the short shared cache described below.

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
- Owner-row locks serialize permission checks, writes, and quota checks across server processes. Reads take no such lock. Deletes free quota; account deletion cascades through collections and documents.
- A site holds at most 10,000 media files: the byte quota alone does not bound row count, since the smallest accepted file is one byte.
- Each individual replacement, update, or delete is atomic. `owner.batch()` makes all of its operations one atomic server transaction, and creates are insert-only. Writes are last-write-wins when `ifVersion` is omitted; `set`, `delete`, and the corresponding batch operations support optimistic compare-and-set with `ifVersion`. There are no realtime subscriptions, offline persistence, custom indexes, arbitrary query expressions, per-document rules, or visitor accounts in v1.

## File uploads (SDK 1.0.0)

Owner sessions can upload files directly to the `naru-media` R2 bucket. The SDK
obtains a ten-minute signed upload URL, sends the bytes directly to R2, and asks
Naru to verify the stored size and content type before returning a ready file.
Database documents should store `file.id` or `file.url`, not base64 data.

```js
const image = await owner.files.upload(fileInput.files[0], {
  signal: abortController.signal,
  metadata: { altText: "A pigeon", postId: "hello" },
});
await owner.collection("posts").set("hello", {
  title: "Hello",
  coverImage: image.url,
});
```

The library pages like a collection, newest first, and `where` filters on the
top-level fields of each file's `metadata`. Storing what you will need to find a
file by means the server does the finding; nothing has to walk the whole library.

```js
const { files } = await owner.files.list({ where: { postId: "hello" } });
for (const file of files) await owner.files.delete(file.id);
```

사이트 소유자는 **미디어 라이브러리**(`/media`)에서 파일을 끌어
놓아 업로드하고, 저장 공간을 확인하고, 이름·형식으로 검색하거나 정렬하고, 공개
URL을 복사하고, 파일을 삭제할 수 있습니다. 삭제 전에 해당 URL을 사용하는 문서를
직접 확인해야 합니다.

Uploads are owner-only and use the same tab-scoped website bearer token as
document writes. Each file is limited to 25 MiB; each site is limited to 250
MiB. JPEG, PNG, WebP, AVIF, GIF, supported audio, PDF, ZIP, and
plain text are accepted. HTML and SVG are rejected. Public objects are served
from the separately isolated `media.naru.pub` origin. Deleting a file removes
both the R2 object and its metadata; deleting an account removes its media
prefix. Upload authorizations that are not finalized, including ones whose
transfer failed, are removed by the background cleanup after one hour.

Bytes go from the browser straight to R2 on a signed URL, so the browser is the
only place a photo can be made smaller before it is stored. The SDK shrinks a
JPEG, PNG, WebP or HEIC image before asking for an authorization when its long
edge exceeds 2048 px or it is larger than 512 KiB: it draws it at most 2048 px
on the long edge and encodes WebP at quality 0.82, or JPEG on a white background
where the browser cannot encode WebP. The declared size is the shrunk size, so
quota and the 25 MiB limit count what is stored. The original is kept when
re-encoding would not make it smaller; HEIC is always converted, since it is not
an accepted type, which is how an iPhone photo uploads from Safari. Re-encoding
drops EXIF: orientation is baked into the pixels and capture coordinates never
reach the public origin. The stored name takes the new extension. There are no
options; the media library at `/media` uploads originals and does not resize.

Public access intentionally permits callers from any origin. Every write that arrives without an owner credential — creates into a `create` collection and replacements or deletes in a `world`-writable one alike — uses database-backed fixed-minute limits of 60 successful writes per site and 20 per caller/IP per site, shared across collections and server processes. Owner writes do not consume these limits. Failed writes roll back their counters.

By default, callers share an `unknown` bucket (20/minute/site). Set `SITE_DATA_TRUST_CLOUDFLARE_IP=1` **only** when a trusted ingress replaces `CF-Connecting-IP` and direct access to the application is blocked. Otherwise clients can spoof the header to evade IP limits. The production `deploy.sh` gateway satisfies this requirement: it recovers the visitor address from the Cloudflare Tunnel's `X-Forwarded-For` chain only for private tunnel peers, then overwrites `CF-Connecting-IP` before proxying to the application. With the setting enabled, valid IPs get separate buckets while invalid/missing headers still share `unknown`. Only a digest is stored in the bucket key; it is not guaranteed anonymization. Old buckets are removed on the next create for that site.

Old buckets are also swept by `cleanup-site-data-grants`, along with expired authorization codes and access tokens, so a site that is used once and left alone does not keep them forever.

These limits do not protect reads, invalid requests or authorization endpoints from high request volumes. `deploy.sh` renders per-client nginx limits for `/api/data/*` (30 r/s, burst 60) and `/api/data-auth/*` (2 r/s, burst 10) with matching body caps, keyed on the visitor address recovered from the trusted tunnel's forwarding chain. PostgreSQL backups must include these new tables; the existing hosted-file export does not include database records.

### Reads, caching and locks

Reads do not take the owner row lock; writes do. Serializing reads behind one
row per site would have queued a popular site's whole audience on a single lock,
each waiter holding a connection from the pool the rest of the control plane
shares. Request transactions also carry a statement deadline, and the pool has
an explicit size (`DATABASE_POOL_MAX`, default 20) and checkout timeout, so a
saturated pool sheds requests instead of hanging on them.

A read of a `world`-readable collection that carries no credential returns the
same bytes to everyone, so it is served with
`Cache-Control: public, max-age=0, s-maxage=10` and the SDK lets the browser and
any shared cache honour it. Anything carrying a credential, every write, and
every error stays `no-store`, so an intermediary that ignores `Vary` can never
replay one caller's authorized response to somebody else.

The SDK remembers every collection this browser writes — anonymous guestbook
entries as well as owner edits, and writes whose response was lost — and reads
that collection with `no-store` for the same ten seconds, so re-reading a list
straight after your own write needs nothing extra. A write made in another
browser can take up to ten seconds to appear in a cached public read.

That window is also the lag on a permission change: changing a collection from
`world` to `admin` stops new reads immediately, but a shared cache may keep
answering an already-cached public read for up to ten seconds, and nothing in
the control plane can purge it. The data was public until that moment, so this
delays hiding it rather than exposing anything new — but treat "make it admin"
as taking effect within seconds, not instantly.

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

The Korean guides are served publicly at `/docs` (index), `/docs/database` and `/docs/media`. The control panel links to it without adding a global header link. The static blog example lives in `control-plane/public/examples/database-blog/`; `/docs/database/blog.zip` packages these same source files at build time. See its README for installation and permission setup.

## Server-side sorting and pagination (SDK 1.0.0)

```js
const posts = collection("posts");
const query = {
  orderBy: [
    ["data.publishedOn", "desc"],
    ["createdAt", "desc"],
  ],
  limit: 20,
};
const first = await posts.list({ ...query, includeTotal: true });
const next = await posts.list({ ...query, pageToken: first.nextPageToken });
```

`orderBy` is always a list of one or two `[field, direction]` pairs. A field is `createdAt`, `updatedAt`, or `data.<field>` for one top-level document field; `direction` is `asc` or `desc`. The document ID is appended automatically as the final tie-breaker, so it may only be named on its own (`[["id", "desc"]]`). Without `orderBy`, a list reads in ID order.

Metadata timestamp ties use document ID in the last direction. JSON-field values use PostgreSQL JSONB ordering; missing fields sort at the same position as JSON null, followed by strings and then numbers. The metadata orders have composite collection/time/ID indexes; JSON-field sorting scans the narrowed collection and has no per-field index.

`get` and `list` return `createdAt` as well as `updatedAt`. Server metadata is camelCase throughout the API; the underlying columns stay snake_case. Creation time is assigned by the server, preserved on replacement, and cannot be changed by fields in `data`. The migration backfills existing documents from their recorded modification time; their original creation time is unknown.

Pass `nextPageToken` unchanged as `pageToken` with the same collection, ordering, and filters. Page tokens are opaque, query-bound continuation state: applications must not inspect or construct them. They preserve PostgreSQL timestamp precision and the last ID, remain usable after that document is deleted, and are bound to the collection's internal ID, every sort key and direction, and the canonical filter fingerprint. Mismatches and malformed tokens return 400. They are not credentials; read permissions are checked on every request. Changing page size is allowed.

A null page token marks the end, and passing `null` as `pageToken` reads the first page, so a "load more" loop can hand `nextPageToken` straight back. Cache prior pages or their starting tokens for a Previous button. There are no page numbers or offsets. `includeTotal: true` returns the filtered total with the page; for only the number, ask for `limit: 1` with it. Reset the token and displayed results when switching sort order or filters. Pagination is not a snapshot: newly inserted records before the token require a refresh; changing a sort value during traversal can skip or repeat a record.

Cancel a superseded read with a standard `AbortController`, passing its `signal`; the request then rejects with the browser's own `AbortError`.

## Equality and range filters with automatic indexes

```js
const page = await collection("posts").list({
  where: {
    category: "일상",
    date: { gte: "2026-09-01", lt: "2026-10-01" },
  },
  orderBy: [["data.date", "desc"]],
  limit: 20,
});
```

HTTP: `GET /api/data/:site/:collection?where=<URL-encoded JSON object>&orderBy=<URL-encoded [["data.date","desc"]]>`. The account API accepts the same parameters. `where` applies to collection and media lists. Conditions address top-level fields and are ANDed. An equality value is a JSON string, finite number, boolean, or null. A range value is an object containing one or more of `gt`, `gte`, `lt`, and `lte`, whose bounds must be finite numbers or strings. Each equality or range bound counts as one predicate, with at most 5 predicates in total. Field names use the same 1–64 ASCII alphanumeric/underscore/hyphen rules as document IDs. The decoded filter JSON is limited to 2,048 UTF-8 bytes. Absent `where` and `{}` mean no filtering.

Equality types match exactly: number 1 differs from string "1"; null matches an explicit null field, not an absent field. Strings match case-sensitively. Arrays and objects cannot be equality values. Range comparisons operate only within the bound's JSON type, so a string bound never selects numeric fields and vice versa; multiple bounds for one field must use the same type. Store sortable dates in a fixed-width representation such as ISO `YYYY-MM-DD`. Missing fields do not match ranges. Nested paths, array membership, OR, and substring search are not supported. Filters are carried in URLs; do not put secrets in them.

A shared PostgreSQL GIN `jsonb_path_ops` index automatically supports equality containment candidate lookup; exact per-field JSONB comparisons enforce scalar equality semantics. Existing collection/ID and collection/time/ID indexes support tenant narrowing and metadata ordering. Range predicates and `data.<field>` sorting scan within the collection narrowed by the site, collection, and any equality candidates, so prefer an equality condition alongside a frequently used range where the data model permits it. PostgreSQL chooses its execution plan based on selectivity; an index does not guarantee every query avoids scanning. No user-managed index configuration is needed. The index migration creates no new document data and its rollback only drops the index. Index creation can block writes while building; schedule production migration accordingly for large databases.

Opaque cursors include a SHA-256 fingerprint of normalized filters. Reordering equivalent keys works; changing, adding or dropping a filter invalidates the cursor. Read permissions and owner scopes are checked on each page. Filters are not authorization: publicly readable collections remain readable without filters.

## Extended blog example

Create `posts` (world/admin), `guestbook` (world/create), and **`drafts` (admin/admin)**. Register the callback with `posts` and `drafts`. Edit the existing callback in the control plane to include both collections; its grants are revoked immediately but its Client ID remains valid. New pages use the shared website Client ID. When upgrading from callback-specific IDs, replace them once with the shared website Client ID and sign in again.

The public list filters by exact `category`. The editor loads paginated posts/drafts, edits documents while preserving other JSON fields, saves private drafts, publishes, and deletes the selected document after confirmation. Local tab storage preserves the editor through the login redirect; explicit server draft saving persists across sessions. Signing out clears the editor and local draft.

Draft and public copies share an ID. Saving a private draft does not unpublish or change an existing public post. Publication uses `owner.batch()` to write the post and remove its draft atomically; failure preserves the draft and leaves the public post unchanged. Deletion affects only the selected collection. Writes that omit `ifVersion` are last-write-wins; an editor can send the version it read to detect a concurrent change and receive `VERSION_CONFLICT` instead of overwriting it. Guestbook moderation remains in the control panel.

### Website identity and admin tokens

`site_data_site_clients` stores one persistent ID per owner, independently of callback rows. Migration preserves callback rows as internal registration IDs, but invalidates all existing authorization codes and website access tokens. Old callback IDs are not accepted as public Client IDs. Each registered page retains its exact callback and collection IDs. Changing a callback URL or its collection permissions revokes all of its codes and access tokens, including when widening scope. Reducing its token lifetime also revokes them. Increasing only the lifetime preserves existing tokens with their original deadlines; pending codes retain the duration already approved. Saving an unchanged registration does not revoke access. Removing a callback cascades the same revocation; the website ID survives even when the last callback is removed.

Every `/api/data-auth/token` exchange returns `{accessToken, tokenType: "Bearer", expiresIn, expiresAt}`. `expiresAt` is the fixed expiry in Unix milliseconds; the token lasts no longer than the configured page lifetime, consented duration, platform maximum, or approving Naru session, whichever ends first. `POST /api/data-auth/revoke` takes the bearer token and revokes it idempotently. The unpublished renewal tables and `/refresh` and `/end-session` endpoints have been removed; the existing access-token table is sufficient. Requests use explicit credentials and never ambient cookies.

### Configuring token lifetime

In the control plane, create or edit a registered admin page and set its token lifetime in minutes (1-1440, default 1440). The account registration API accepts `tokenLifetimeSeconds` as a whole-minute integer in seconds, from 60 through 86400. Existing registrations and outstanding codes migrate with a default of 86400; existing token deadlines are preserved. `PATCH /api/account/database-clients` can update only `{id, tokenLifetimeSeconds}`. Omitting this field preserves the current lifetime. Other users and website bearer tokens cannot change it. Database constraints enforce the range as well as application validation.

Consent displays the configured duration and submits that displayed value. Approval binds the smaller of the current registration limit and the displayed duration to the one-use code; exchange cannot widen it with an SDK argument or a concurrent settings increase. Shortening a registration revokes pending codes as well as issued tokens. Rollback revokes outstanding grants before returning to the old fixed-lifetime behavior.

### SDK 1.0.0 data and error contract

`collection<Post>("posts")` and `owner.collection<Post>("posts")` type reads,
lists and complete replacement writes. Types describe the application's
schema; the SDK does not validate documents or server responses at runtime.

Data is sent with `JSON.stringify`, so values it drops or coerces (undefined,
functions, `Date`) are stored the way it serializes them. Convert dates to
strings explicitly. `set()` replaces the entire document; there is no merge.
Each successful document write increments `version`. Pass a previously read
version as `ifVersion` to `set()` or `delete()` to reject a stale write with
`status: 409` and `code: "VERSION_CONFLICT"`; `ifVersion: 0` asserts that the
document does not exist.

A response with an error status throws `NaruDataError` with that `status` and
the server's `code`, or `REQUEST_FAILED` (`OWNER_SESSION_EXPIRED` for 401) when
it sent none, including non-JSON proxy responses. Network failures and
cancellation reject with the browser's own `TypeError` and `AbortError`. A
collection name or ID outside 1–64 ASCII letters, digits, underscores and
hyphens throws `TypeError` before any request. Other invalid input is the
server's to refuse with a 400.

There are no automatic retries. A failed or interrupted response does not prove
that a write failed: retrying `add()` can create another document. Read back or
reconcile before retrying. Cursor pagination is not a snapshot: concurrent edits
can move records between pages, especially when sorting by `updatedAt`.
