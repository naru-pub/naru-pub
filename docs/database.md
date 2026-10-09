# Site databases (Naru Data v1)

Naru Data stores each site’s collections and JSON documents in a SQLite-backed Cloudflare Durable Object. PostgreSQL holds accounts, entitlements, website authentication, and media metadata. Static sites use a dependency-free browser ES module; owners manage data and collection permissions at `/database` in the control plane. No Rust proxy changes or separate database hostname are required.

The concise public contract is documented in the [Naru Data SDK v1 API
reference](sdk-v1-api.md). This document covers setup, server operation, limits,
and the private HTTP protocol behind that interface.

## Setup

From `control-plane`, install dependencies and run `pnpm migrate` against your intended development database before starting the app. For production, run the migration as part of the normal deployment procedure before serving the new API. PostgreSQL migrations maintain accounts, website registrations, authorization-code/token hashes, and media metadata. Worker deployments maintain the per-site SQLite schema. Historical migrations remain necessary for upgrades; the removal migration refuses to drop PostgreSQL collections belonging to sites that were never moved. Such installations must migrate their data using the previous release before upgrading. Do not roll back historical migrations to restore the former document backend.

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

Public API calls deliberately ignore cookies. SDK requests always use `credentials: "omit"`. An explicit owner bearer token grants scoped document access after Naru login; invalid or expired credentials never fall back to public access. Control-plane requests use the existing same-origin admin session. Never embed an admin session, password or fixed token in a public site.

## Browser SDK

Create a collection in the control plane, choose its permissions, then use this in a static page. The database and its collections are created in the control plane; a page only names them. Both the SDK and the public API support CORS.

```html
<script type="module">
  import { createNaru, NaruError } from "https://naru.pub/sdk/1/naru.js";
  const naru = createNaru();
  const entries = naru.collection("guestbook");

  try {
    const { id } = await entries.add({ name: "Visitor", message: "Hello!" });
    const document = await entries.get(id);
    // set() and delete() require admin access or full public write permission.
    let cursor = null;
    do {
      const page = await entries.list({ size: 20, after: cursor });
      render(page.documents);
      cursor = page.nextCursor;
    } while (cursor);
  } catch (error) {
    if (error instanceof NaruError) console.error(error.code, error.message);
    else throw error;
  }
</script>
```

A page served from `<login>.naru.pub` belongs to that site, so `createNaru()` needs nothing else. A custom domain or local page uses `createNaru({ site: "login-name" })`. Every collection and authentication operation then comes from that one client.

`get` returns `{ id, data, revision, createdAt, updatedAt }`; a missing document throws `NaruError` with `code: "NOT_FOUND"`. `set` replaces the whole document or creates it if absent. `add` generates an opaque ID without requiring read permission. `add` and `set` return `{ id, data, revision, createdAt, updatedAt }`, so a caller rendering what it just saved uses the server's own timestamps rather than the browser clock. `delete` is idempotent and resolves with nothing. JSON null is stored as a value, not treated as deletion. Render user data with `textContent`, not `innerHTML`.

SDK declarations are available alongside the module at `/sdk/1/naru.d.ts`. The SDK pins `https://naru.pub` as its control-plane origin, even when bundled/copied. It takes no option to change that; Naru's own integration tests redirect its requests to a loopback server in their `fetch` shim instead.

## Website owner login

1. Open `/database` directly in the control plane (it is intentionally absent from the header).
2. Under website administrator login, register the editor page's URL such as `https://your-login-name.naru.pub/admin.html` and select the collections it may access. A registration names a page, so it also matches the other addresses the proxy serves that page at (`/` and `/index.html`; `/about`, `/about/` and `/about/index.html`). Registrations are stored as typed; only the server compares them this way, beside the proxy whose routing it mirrors, and approval redirects back to the exact address the sign-in left from, where the SDK keeps its pending sign-in. The callback must be on your Naru subdomain or an active, verified custom domain; no query, fragment, credentials, wildcard or arbitrary external origin. Development mode also permits loopback callbacks.
3. Nothing else needs configuring: the site name and the callback page identify the registration. Each callback keeps independent collection permissions. Registering first is optional: when the page is not registered, asks for collections the site does not have, or asks for collections its registration lacks, the consent page offers to register it, create those collections (private, admin read and write) or add them to the registration, on the owner's explicit click, before the separate approval step. Adding collections to a registration revokes its outstanding sign-ins, as editing it in the control panel does. It offers nothing when the signed-in account is not the site's owner or the page is not on their site or verified domain.
4. Call `naru.auth.signIn({ collections })` from a button. Naru authenticates the owner and asks for explicit consent. The website resumes at the registered callback, where `naru.auth.session()` returns a separate authenticated client.

Minimal editor-page wiring:

```html
<meta name="referrer" content="no-referrer" />
<button id="login">Sign in to edit</button>
<button id="save" disabled>Publish example post</button>
<button id="logout" disabled>Sign out</button>
<p id="status"></p>
<script type="module">
  import { createNaru } from "https://naru.pub/sdk/1/naru.js";
  const naru = createNaru();
  const status = document.querySelector("#status");
  async function run(action) {
    try {
      await action();
    } catch (error) {
      if (error.code === "AUTH_REQUIRED") admin = null;
      status.textContent = error.message;
    }
  }
  // Call early on the callback page: it strips code/state from the address.
  let admin = await naru.auth.session();
  document.querySelector("#save").disabled = !admin;
  document.querySelector("#logout").disabled = !admin;
  document.querySelector("#login").onclick = () =>
    run(() => naru.auth.signIn({ collections: ["posts"] }));
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

The site name and the exact callback URL identify the registration; there is no client ID. The requested collections must be a subset of the registration. Handles from `naru.collection()` never use admin credentials; only `admin.collection()` uses admin authority. Tokens permit reading, creating, replacing and deleting documents in those collections, including private documents. They are tied to collection IDs so deleting and recreating a collection does not transfer old grants.

Authentication uses random state and mandatory S256 PKCE. The verifier and state live in tab-scoped sessionStorage for at most ten minutes; authorization codes expire after 60 seconds and are single-use, including concurrent exchanges. The server stores only code/token hashes. Each registered admin page has a control-plane token lifetime of 1-1440 whole minutes (default 1440). Each sign-in issues one opaque admin token capped by this setting, the duration displayed at consent, and the approving Naru session. The platform maximum remains 24 hours.

That lifetime is an idle window rather than a countdown to being signed out mid-edit: an accepted owner request renews the token, so a page in use keeps working. Renewal stops at whichever comes first — seven days after the token was issued, the approving Naru session's own expiry, or a lifetime the registration has since lowered — and never shortens an expiry the token already has. Like a Naru session, a token is only rewritten once it is past the halfway mark, so an active page costs one extra write per half-window. Revocation, registration changes and session deletion end a token immediately, regardless of renewal. Session storage, restoration, and expiry remain SDK implementation details; a website never sees a token deadline.

Control-plane session expiry/deletion, registration removal, token revocation, and domain status are checked on every authenticated data request. Use the control panel to revoke a page's outstanding codes and tokens, or remove its registration to disable future login. `naru.auth.session()` only finishes a sign-in that this tab started with `naru.auth.signIn()`; a page's own `?code=` or `?error=` parameters are left untouched otherwise. A sign-in that returns denied, stale or unexchangeable resolves `null` like any signed-out visit. `admin.signOut()` clears local credentials and disables that handle before requesting server revocation, so a failed revocation cannot leave the page signed in. An unusable admin session fails with `AUTH_REQUIRED`, and the next `naru.auth.session()` returns null. A network failure is `UNAVAILABLE`. This does not sign out of the Naru control plane. Never share admin authority or load untrusted scripts on an editor page.

Authorization approval and registration changes require same-origin owner requests. Token exchange and API access require the registered origin plus the explicit code/verifier or bearer token; CORS never grants authorization. The consent page disallows framing. An origin check cannot prevent use of a stolen bearer token by a non-browser client: scripts running on your editor page can exercise owner privileges while signed in. Use a minimal trusted editor without third-party scripts, avoid unsafe HTML rendering, and set a no-referrer policy on the callback page.

## SDK releases

Two URLs serve the SDK, and a site picks one:

- `/sdk/1/naru.js` (and `/sdk/1/naru.d.ts`) is the newest 1.x release. A site that imports it picks up compatible fixes and additions without changing anything. This is what the docs and the example blog use.
- `/sdk/1.0.0/naru.js` is one exact release, for a site that wants the same code on every load. **1.0.0 remains under active development and will continue to be updated until the project owner says otherwise**; once frozen it never changes, and fixes ship as 1.0.1 and so on.

Each version is written in TypeScript at `control-plane/sdk/<version>/naru.ts`; `pnpm sdk:build` emits the served `naru.js` and `naru.d.ts` beside each other under `public/sdk/<version>/`, and those emitted files are committed, so a deploy serves exactly what was reviewed. `pnpm build` refuses to proceed while they are stale. Both are served `no-cache`, so browsers revalidate. `/sdk/1/` is a rewrite in `next.config.mjs`; point it at the newest 1.x directory when one ships. Unversioned SDK URLs are not served. A change that would break a 1.x caller goes into `/sdk/2/`.

The wire protocol is versioned separately, in the path: `/api/data/v1/:site` and `/api/data-auth/v1/*`. Every 1.x SDK file that was ever served keeps calling these, including copies cached or bundled by sites, so they stay compatible for as long as 1.x is supported: routes, parameters, response shapes and error codes. Breaking server changes need `/api/data/v2/` alongside v1.

The 1.0.0 SDK is deliberately small. Its runtime exports are only `createNaru` and `NaruError`. A client has `collection()` and `auth`; a collection has `get()`, `list()`, `count()`, `pages()` and `add()` (plus `set()` and `delete()` for an admin); an admin client has `collection()`, `batch()`, `media.upload()` and `signOut()`. Media listing and deletion remain in the control panel. Features are added when a site needs them, not in advance.

During 1.0.0 development the SDK dropped `createDatabase`, per-collection `parse`/`map`, `schemas`, `update` merge patches and `unset`, `count()`, `all()`, string `orderBy` with `direction`, `fresh`, `timeoutMs`, `createRequestChannel`, session events, application schema parsing and response validation, upload progress, image tuning options, and the file `get`, `update` and `usage` methods. The server removed the obsolete public endpoints and options. The SDK still validates JSON values and uses private transport parameters for cache bypass.

## Internal HTTP protocol

This is the v1 wire format the SDK speaks. Applications use the SDK, not these
routes, but released SDK files depend on them, so the website root below is a
compatibility surface: change it only compatibly. Query parameters and response
fields use the SDK's own names, so the SDK passes them through; the server turns
private numeric versions into opaque revisions.

Website root: `/api/data/v1/:site`. Control-plane root: `/api/account/database` (site derived from the session; ships with the server and is not versioned). Collection management is restricted to the control-plane root. Collection names starting with `_` are reserved for the protocol's own paths (`_batch`, `_files`) and cannot be created.

| Method | Path relative to root                    | Body / result                                                     |
| ------ | ---------------------------------------- | ----------------------------------------------------------------- |
| GET    | `/`                                      | Admin only: `{ collections }`                                     |
| POST   | `/`                                      | Admin only: `{ name, read?, write? }` creates collection          |
| PATCH  | `/:collection`                           | Control panel only: `{ read, write }` replaces permissions        |
| DELETE | `/:collection`                           | Admin only: deletes collection and its documents                  |
| GET    | `/:collection?size=50&after=cursor`      | `{ documents, nextCursor, totalCount? }`; accepts sort and filter |
| POST   | `/:collection`                           | `{ data }` creates document; returns the write result             |
| GET    | `/:collection/:id`                       | `{ document }`                                                    |
| PUT    | `/:collection/:id?ifRevision=&ifAbsent=` | `{ data }` replaces document; returns the write result            |
| DELETE | `/:collection/:id?ifRevision=`           | `{ success: true }`                                               |
| POST   | `/_batch`                                | Admin-only atomic set/delete `{ operations }`                     |
| GET    | `/_files?size=50&after=`                 | Control panel only: `{ files, nextCursor }`, newest first         |
| GET    | `/_files?usage=1`                        | Control panel only: `{ usage }`                                   |
| POST   | `/_files`                                | Admin-only upload authorization                                   |
| PUT    | `/_files/:id`                            | Admin-only finalize; verifies the stored bytes                    |
| DELETE | `/_files/:id`                            | Control panel only: `{ success: true }`                           |

A response to an owner request that renewed its token carries `Naru-Owner-Expires`, the new expiry as epoch milliseconds, and `Naru-Owner-Expires-In`, the same expiry as whole seconds from now, both exposed to the page through CORS. The SDK adds the duration to its own clock, so a device whose clock is wrong neither signs out early nor keeps a session past its end; the instant stays for SDK files that already read it. Both are additive, so an SDK that ignores them simply holds an expiry no later than the true one. A public write result is `{ id, data, revision, createdAt, updatedAt }`. A delete, alone or batched, refuses an absence condition. `_batch` takes `set` and `delete` operations only (a server-assigned id is `add`'s, outside transactions) and answers `{ success: true, results }`: in operation order, `{ id, revision, createdAt, updatedAt }` for a set and `null` for a delete, never the data. A website token may only authorize and finalize uploads; the media library is listed and deleted from the control panel. A private `fresh=1` query flag forces a non-cacheable read; it is not an SDK option. A list accepts `filter` and `sort` (URL-encoded JSON, exactly as passed to the SDK), `size`, `after` and `includeTotal=1`. An upload authorization takes `{ name, contentType, size }` and returns `{ id, uploadUrl, headers }`: PUT the bytes to `uploadUrl` with those headers, then finalize with `PUT /_files/:id`. The SDK returns a file's `{ url, name, contentType, size }`; the control panel's library reads `{ id, name, contentType, size, url, createdAt, updatedAt }`. The public route does not accept `PATCH`.

All JSON request bodies require `Content-Type: application/json`. Website errors return `{ error: { code, message } }`, where `code` is one of the v1 codes in the [SDK reference](sdk-v1-api.md#errors-and-cancellation); the server sets it, and the HTTP status is diagnostic. A `DataError` names its code only where the status alone would be wrong (a failed condition and a full quota are both 409, for instance); otherwise 401, 403, 404, 429 and 5xx map to `AUTH_REQUIRED`, `ACCESS_DENIED`, `NOT_FOUND`, `RATE_LIMITED` and `UNAVAILABLE`, and any other status to `INVALID_REQUEST`. The v1 code list is closed: a new code needs a new protocol version, and the SDK reads a code it does not know by its status. The control-plane root keeps `{ error }` with a plain message. Public preflight needs no authentication. Errors, writes, and authenticated reads are not cached; anonymous reads from `world`-readable collections may use the short shared cache described below.

Administrator authorization endpoints:

| Endpoint                        | Purpose                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /database/authorize`       | Login/consent UI; never issues a code on GET.                                                                                |
| `POST /api/data-auth/authorize` | Same-origin owner approval with `site`, `redirectUri`, `challenge`, `state`, `collections`; returns validated redirect URL.  |
| `POST /api/data-auth/v1/token`  | Exchange JSON `{ code, verifier, redirectUri }` from the registered Origin; returns `{ accessToken, expiresIn, expiresAt }`. |
| `POST /api/data-auth/v1/revoke` | Revoke the bearer token supplied in Authorization; requires its registered Origin.                                           |

There is no discovery request. A `clientId` sent by an SDK copy from before it was dropped, in the consent query or the token exchange, is ignored: the code is bound to one registration, and consent looks the registration up by the signed-in owner, `site` and callback page. The `v1/` endpoints are what websites call and answer with the coded error body. `POST /api/data-auth/authorize` is the consent screen's own same-origin call. Released SDKs also fix the consent page's query (`site`, `redirectUri`, `challenge`, `state`, `collections`) and the `code`, `state` and `error` it returns to the callback, so those change only compatibly too.
| `GET/POST /api/account/database-clients` | Same-origin owner registration listing/creation (`{ redirectUri, collections }`). |
| `PATCH/DELETE /api/account/database-clients` | Same-origin owner revoke-all/remove registration (`{ id }`). |

There are at most 20 registrations per site, 20 pending codes and 50 live tokens per registration. Expired grants are cleaned during authorization activity. Removing registrations/accounts/sessions cascades into their grants.

## Limits and consistency

- 100 collections, 10,000 documents, and 10 MiB of serialized JSON per site, separate from the hosted-file quota.
- Maximum request body: 64 KiB, including the `{ data }` envelope; enforced while streaming, even without Content-Length.
- Collection names and document IDs: 1–64 ASCII letters, numbers, underscores or hyphens.
- Pages: 1–100 documents (default 50), defaulting to ID ascending in byte order. See sorting below; pagination is not a snapshot across concurrent changes.
- Documents use JSON values with JavaScript number precision and no significant object key order. Application-visible ordering is defined by Naru, not by database collation.
- Each site's Durable Object serializes document and collection operations in synchronous SQLite transactions, including permission and quota checks. Deletes free quota; account deletion erases the site's object. Media operations retain their PostgreSQL transaction path.
- A site holds at most 10,000 media files: the byte quota alone does not bound row count, since the smallest accepted file is one byte.
- Each individual replacement or delete is atomic. `admin.batch()` makes its ID-addressed sets and deletes one atomic server transaction. Writes are last-write-wins when no condition is supplied; `condition.revision` rejects stale writes and `condition.absent` guards creation. There are no realtime subscriptions, offline persistence, custom indexes, arbitrary query expressions, per-document rules, or visitor accounts in v1.

## File uploads (SDK 1.0.0)

Admin sessions can upload files directly to the `naru-media` R2 bucket. The SDK
obtains a ten-minute signed upload URL, sends the bytes directly to R2, and asks
Naru to verify the stored size and content type before returning a ready file.
Database documents should store `file.url`, not base64 data.

```js
const image = await admin.media.upload(fileInput.files[0], {
  signal: abortController.signal,
});
await admin.collection("posts").set("hello", {
  title: "Hello",
  coverImage: image.url,
});
```

Naru does not record which documents use a file: a page that uses a file stores
its URL, and deletion is a deliberate act in the control-plane media library.
The site SDK deliberately exposes upload only. Uploads that are no longer
referenced stay until someone deletes them in the media library.

사이트 소유자는 **미디어 라이브러리**(`/media`)에서 파일을 끌어
놓아 업로드하고, 저장 공간을 확인하고, 이름·형식으로 검색하거나 정렬하고, 공개
URL을 복사하고, 파일을 삭제할 수 있습니다. 삭제 전에 해당 URL을 사용하는 문서를
직접 확인해야 합니다.

Uploads are owner-only and use the same tab-scoped website bearer token as
document writes. Each file is limited to 25 MiB; each site is limited to 250
MiB. JPEG, PNG, WebP, AVIF, GIF, supported audio, PDF, ZIP, and
plain text are accepted. HTML and SVG are rejected. Public objects are served
from the separately isolated `media.naru.pub` origin. Deleting a file removes
both the R2 object and its database row; deleting an account removes its media
prefix. Upload authorizations that are not finalized, including ones whose
transfer failed, are removed by the background cleanup after one hour.

Bytes go from the browser straight to R2 on a signed URL, so the browser is the
only place a photo can be made smaller before it is stored. The current implementation (not a frozen SDK guarantee) shrinks a
JPEG, PNG, WebP or HEIC image before asking for an authorization when its long
edge exceeds 2048 px or it is larger than 512 KiB: it draws it at most 2048 px
on the long edge and encodes WebP at quality 0.82, or JPEG on a white background
where the browser cannot encode WebP. The declared size is the shrunk size, so
quota and the 25 MiB limit count what is stored. The original is kept when
re-encoding would not make it smaller; HEIC is always converted, since it is not
an accepted type, which is how an iPhone photo uploads from Safari. Where the
browser cannot decode HEIC (Chrome, Firefox), the SDK throws `TypeError` before
asking for an authorization; a file named `.heic`/`.heif` with an empty type
counts as HEIC. Every other type is left to the server's allowlist. Re-encoding
drops EXIF and bakes orientation into the pixels. Files retained unchanged may
still contain metadata; upload is not a metadata-removal guarantee. The stored name takes the new extension. There are no
image options; the media library at `/media` uploads originals and does not resize.

Upload progress comes from the one step that has bytes to count, the PUT to R2.
`fetch` exposes no upload progress, and streaming its body to count it would
send no `Content-Length`, which a presigned PUT requires, so when a caller
passes `onProgress` the SDK sends that same PUT with `XMLHttpRequest` (as the
`/media` library does); without it, the SDK uses `fetch` as before. The request
is the same, headers and CORS preflight included, so the bucket's existing CORS
rule covers it. `XMLHttpRequest` cannot refuse a redirect, so a response whose
`responseURL` is not the signed URL is treated as a failed upload.

Public access permits callers from any origin. Anonymous writes into `create` or `world` collections use fixed-minute limits of 60 successful writes per site and 20 per caller/IP per site. Each site's Durable Object stores and checks these counters in the write transaction. Owner writes do not count, and failed writes roll back their counters.

The Worker reads the visitor IP from Cloudflare’s trusted header. Requests forwarded through the control plane share an `unknown` bucket (20/minute/site) unless trusted IP forwarding is enabled. Set `SITE_DATA_TRUST_CLOUDFLARE_IP=1` **only** when a trusted ingress replaces `CF-Connecting-IP` and direct access to the application is blocked. Otherwise clients can spoof the header to evade IP limits. The production gateway that `deploy-server.sh` renders satisfies this requirement: it recovers the visitor address from the Cloudflare Tunnel's `X-Forwarded-For` chain only for private tunnel peers, then overwrites `CF-Connecting-IP` before proxying to the application. With the setting enabled, valid IPs get separate buckets while invalid/missing headers still share `unknown`. Only a digest is stored in the bucket key; it is not guaranteed anonymization. The object removes expired buckets during anonymous-write admission.

`cleanup-site-data-grants` periodically removes expired authorization codes and access tokens from PostgreSQL. It does not touch the object’s rate-limit buckets.

These limits do not protect reads, invalid requests or authorization endpoints from high request volumes. `deploy-server.sh` renders per-client nginx limits for `/api/data/*` (30 r/s, burst 60) and `/api/data-auth/*` (2 r/s, burst 10) with matching body caps, keyed on the visitor address recovered from the trusted tunnel's forwarding chain. PostgreSQL backups cover authentication and media metadata, not the documents stored in Durable Objects. The existing hosted-file export does not include site database documents.

### Reads and caching

Anonymous document reads normally reach only the Worker and its Durable Object.
Requests requiring the control plane use PostgreSQL for admission and
credentials, with statement deadlines, a bounded pool (`DATABASE_POOL_MAX`,
default 20), and a checkout timeout. Document operations run in the object's
SQLite transaction, independently of the PostgreSQL pool.

A read of a `world`-readable collection that carries no credential returns the
same bytes to everyone, so it is served with
`Cache-Control: public, max-age=0, s-maxage=10` and the SDK lets the browser and
any shared cache honour it. Anything carrying a credential, every write, and
every error stays `no-store`, so an intermediary that ignores `Vary` can never
replay one caller's authorized response to somebody else.

The SDK remembers every collection this loaded module writes, including writes
whose response was lost. Its subsequent reads of those collections carry the
private `fresh=1` transport flag and request `no-store`. The server answers
these reads with `no-store` too; caches never store this separate query variant.
This lasts until the module is reloaded and is independent of the server's
cache lifetime. Unwritten collections continue to benefit from shared caching.
Other browsers can see public writes after the shared cache expires.

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
```

Integration tests require an empty database named exactly `naru_data_test`. They cover all permission combinations, create-only restrictions, rate/quota races, PKCE, single-use codes, token scope, expiry, renewal and its bounds, revocation, domain validation and session/registration deletion. HTTP tests cover cookie isolation, same-origin admin protection, authentication and preflight; SDK tests cover CRUD transport and errors. The dedicated Jest config avoids obsolete global Lucia and Request mocks in the existing test setup.

The full database suite starts a scratch PostgreSQL cluster for accounts and
authentication and a local Worker under `wrangler dev`. Install dependencies
in both `control-plane/` and `edge/` first:

```sh
cd control-plane
pnpm test:data:db
```

## Durable Objects backend

All site collections and documents live in the `naru-site-data` Worker, in one
SQLite-backed Durable Object per site, named by the site. The control plane's
`lib/site-data/service.ts` checks account existence, paid status, and owner
sign-in scope before calling private Worker operations over HTTPS with a
shared secret. Configure `SITE_DATA_WORKER_URL=https://site-data.naru.pub`
and `SITE_DATA_WORKER_SECRET`; there is no PostgreSQL document fallback.

PostgreSQL retains accounts, entitlements, website registrations,
authorization codes and tokens, and media metadata. Media bytes remain in R2.
The object uses the shared validation, filter and cursor modules and serializes
operations in synchronous SQLite transactions. Public-write rate limits are
counted in the object. Timestamps have millisecond precision, collection names
are listed in byte order, and JSON object key order has no contract meaning.

### Answering visitors at the edge

The configured `naru.pub/api/data/v1/*` Worker route covers every site.
`edge/src/website.ts` answers anonymous document requests from
that site's object using shared headers, caching and errors. It forwards
requests with owner tokens, `_files`, `_batch`, and requests the object cannot
serve to the control plane. That fallback still uses the same Durable Object
for documents; PostgreSQL handles authentication and media metadata.

The object serves visitors only while its database entitlement is valid and
its confirmation is current. Otherwise it sends the request to the control
plane, which checks PostgreSQL: the edge never refuses on paid status, so a
lapsed site is refused on time and a renewed one is served at once, without
waiting for the next sync. The `site-data-edge-sync` job runs every five
minutes, sends the entitlement end date and a one-hour confirmation, and copies
document count and bytes used to `users` for admin reporting. It includes
active complimentary accounts and subscriptions that expired within the last
60 days. Expired confirmations defer to the control plane's entitlement check.
The job does not create routes or copy documents.

Public reads may be cached at the edge for ten seconds. `fresh=1` reads are
never cached. The zone's cache rule does not apply to Worker responses.

### Monthly request budget

Each site answers at most 500,000 anonymous requests per calendar month (UTC)
by default. Owner requests and requests answered from the edge cache do not
count. After the budget is spent, visitors receive 429 `RATE_LIMITED` until
the next month. `SITE_MONTHLY_REQUESTS` sets the default; `monthlyRequests`
in `configure` overrides it for a site. Counts are persisted every 25 requests,
so an evicted object can forget up to 24 requests.

Collection creation outside a document request, such as website registration
or board-template application, commits in the object separately from the
PostgreSQL transaction. Template applications record the application first;
failed collection creation is reported as skipped.

## Public guide and example

The Korean guides are served publicly at `/docs` (index), `/docs/database` and `/docs/media`. The control panel links to it without adding a global header link. The static blog example lives in `control-plane/public/examples/database-blog/`; `/docs/database/blog.zip` packages these same source files at build time. See its README for installation and permission setup.

## Server-side sorting and pagination (SDK 1.0.0)

```js
const naru = createNaru();
const posts = naru.collection("posts");
const query = {
  sort: [
    ["publishedOn", "desc"],
    [{ metadata: "createdAt" }, "desc"],
  ],
  size: 20,
};
const first = await posts.list({ ...query, includeTotal: true });
const next = await posts.list({ ...query, after: first.nextCursor });
```

`sort` is always a list of one or two `[field, direction]` pairs. User fields are named directly; metadata uses `{ metadata: "id" | "createdAt" | "updatedAt" }`, and the ID may only be the sole key. `direction` is `asc` or `desc`. The document ID is appended automatically as the final tie-breaker. Without `sort`, a list reads in ID order.

Metadata timestamp ties use document ID in the last direction. IDs use ASCII
order. User fields sort ascending as missing/null/non-scalars, strings, numbers,
then booleans (false before true). Strings use Unicode code-point order without
locale rules or normalization; numbers compare numerically. Descending reverses
the order. Arrays and objects tie with null and missing fields. The SQL builds
these keys explicitly rather than relying on database-native JSON ordering.
The explicit-document-ordering migration sets ID collation to C and rebuilds
the existing primary and metadata indexes. It holds a table lock while doing so;
allow a maintenance window for large installations. Its rollback restores the
database default collation without changing document data.
Metadata orders have composite collection/time/ID indexes; JSON-field sorting
scans the narrowed collection and has no per-field index.

`get`, `add`, `set`, and the documents in `list` return `data`, `createdAt`, and `updatedAt`. Server metadata is camelCase throughout the API; the underlying columns stay snake_case. Creation time is assigned by the server, preserved on replacement, and cannot be changed by fields in `data`. The migration backfills existing documents from their recorded modification time; their original creation time is unknown.

Pass `nextCursor` unchanged as `after` with the same collection, ordering, and filters. Cursors are opaque, query-bound continuation state: applications must not inspect or construct them. The SDK and server may change their representation. They are not credentials; read permissions are checked on every request. Changing page size is allowed.

A null cursor marks the end, and passing `null` as `after` reads the first page. Cache prior pages or their starting cursors for a Previous button. There are no page numbers or offsets. `includeTotal: true` returns `totalCount`; for only the number, use `size: 1`. Reset the cursor and displayed results when switching sort order or filters. Pagination is not a snapshot across requests: newly inserted records before the cursor require a refresh; changing a sort value during traversal can skip or repeat a record.

Cancel a superseded read with a standard `AbortController`, passing its `signal`; the request then rejects with the browser's own `AbortError`.

## Equality and range filters with automatic indexes

```js
const page = await naru.collection("posts").list({
  filter: {
    category: "일상",
    date: { gte: "2026-09-01", lt: "2026-10-01" },
  },
  sort: [["date", "desc"]],
  size: 20,
});
```

HTTP: `GET /api/data/v1/:site/:collection?filter=<URL-encoded JSON object>&sort=<URL-encoded [["date","desc"]]>`. The account API accepts the same parameters. Media lists refuse a `filter`. Conditions address top-level fields and are ANDed. An equality value is a JSON string, finite number, boolean, or null. A range value is an object containing one or more of `gt`, `gte`, `lt`, and `lte`, whose bounds must be finite numbers or strings. Each equality or range bound counts as one predicate, with at most 5 predicates in total. Field names use the same 1–64 ASCII alphanumeric/underscore/hyphen rules as document IDs. The decoded filter JSON is limited to 2,048 UTF-8 bytes. Absent `filter` and `{}` mean no filtering.

Equality types match exactly: number 1 differs from string "1"; null matches an explicit null field, not an absent field. Strings match case-sensitively. Arrays and objects cannot be equality values. Range comparisons operate only within the bound's JSON type, so a string bound never selects numeric fields and vice versa; multiple bounds for one field must use the same type. Store sortable dates in a fixed-width representation such as ISO `YYYY-MM-DD`. Missing fields do not match ranges. Nested paths, array membership, OR, and substring search are not supported. Filters are carried in URLs; do not put secrets in them.

SQLite indexes support collection/ID and collection/time ordering. Document-field filters and sorting use SQLite JSON expressions within the selected collection. There are no user-managed indexes; field sorting and filtering may scan that collection.

Opaque cursors include a SHA-256 fingerprint of normalized filters. Reordering equivalent keys works; changing, adding or dropping a filter invalidates the cursor. Read permissions and admin scopes are checked on each page. Filters are not authorization: publicly readable collections remain readable without filters.

## Extended blog example

Create `posts` (world/admin), `guestbook` (world/create), and **`drafts` (admin/admin)**. Register the callback with `posts` and `drafts`. Edit the existing callback in the control plane to include both collections; its grants are revoked immediately. No Client ID is needed; site and registered page URL identify the page.

The public list filters by exact `category`. The editor loads paginated posts/drafts, edits documents while preserving other JSON fields, saves private drafts, publishes, and deletes the selected document after confirmation. Local tab storage preserves the editor through the login redirect; explicit server draft saving persists across sessions. Signing out clears the editor and local draft.

Draft and public copies share an ID. Saving a private draft does not unpublish or change an existing public post. Publication uses `admin.batch()` to write the post and remove its draft atomically; failure preserves the draft and leaves the public post unchanged. Deletion affects only the selected collection. An editor returns the opaque revision it read as `condition.revision` to detect a concurrent change and receive `CONFLICT` instead of overwriting it. Guestbook moderation remains in the control panel.

### Website identity and admin tokens

Sign-in identifies the site and registered page URL. Each registered page retains its callback and collection IDs. Changing a callback URL or its collection permissions revokes all of its codes and access tokens, including when widening scope. Reducing its token lifetime also revokes them. Increasing only the lifetime preserves existing tokens with their original deadlines; pending codes retain the duration already approved. Saving an unchanged registration does not revoke access. Removing a callback cascades the same revocation.

Every `/api/data-auth/v1/token` exchange returns `{ accessToken, expiresIn, expiresAt }`; the token is sent as `Authorization: Bearer <accessToken>`. `expiresIn` is the lifetime in whole seconds, which the SDK measures on the browser's clock; `expiresAt` is the same expiry in Unix milliseconds on the server's clock, kept for SDK files that read it. Accepted owner requests renew the idle window within the hard bounds described under authentication above; the `Naru-Owner-Expires-In` response header on a renewal keeps the SDK current. `POST /api/data-auth/v1/revoke` takes the bearer token and revokes it idempotently. The unpublished renewal tables and `/refresh` and `/end-session` endpoints have been removed; the existing access-token table is sufficient. Requests use explicit credentials and never ambient cookies.

### Configuring token lifetime

In the control plane, create or edit a registered admin page and set its token lifetime in minutes (1-1440, default 1440). The account registration API accepts `tokenLifetimeSeconds` as a whole-minute integer in seconds, from 60 through 86400. Existing registrations and outstanding codes migrate with a default of 86400; existing token deadlines are preserved. `PATCH /api/account/database-clients` can update only `{id, tokenLifetimeSeconds}`. Omitting this field preserves the current lifetime. Other users and website bearer tokens cannot change it. Database constraints enforce the range as well as application validation.

Consent displays the configured duration and submits that displayed value. Approval binds the smaller of the current registration limit and the displayed duration to the one-use code; exchange cannot widen it with an SDK argument or a concurrent settings increase. Shortening a registration revokes pending codes as well as issued tokens. Rollback revokes outstanding grants before returning to the old fixed-lifetime behavior.

### SDK 1.0.0 data and error contract

`collection<Post>("posts")` and `admin.collection<Post>("posts")` type reads,
lists and complete replacement writes. Types describe the application's
schema; the SDK checks JSON values but does not validate application fields at runtime.

Only JSON values are accepted: null, booleans, strings, finite numbers, dense
arrays, and plain objects. Undefined, functions, symbols, bigint, dates, class
instances, accessors, sparse arrays, and cycles throw `TypeError` before sending.
Convert dates to strings explicitly. `set()` replaces the entire document;
there is no merge. `get`, `add`, and `set` return the same document shape,
including the stored data. A create-only visitor receives its own saved data,
without gaining access to any previous or other document.
Each successful document write returns an opaque `revision`. Pass a previously
read revision as `condition.revision` to `set()` or `delete()` to reject a stale write
with `code: "CONFLICT"`; `condition: { absent: true }` asserts that the document does not
exist; it applies to `set()` only. Applications must not parse or construct revisions.

A failed operation throws `NaruError` with a stable semantic `code` such as
`CONFLICT`, `QUOTA_EXCEEDED`, `AUTH_REQUIRED`, `RATE_LIMITED`, or `UNAVAILABLE`. HTTP status and
the original cause are diagnostic only. Network and invalid proxy responses are
normalized to `UNAVAILABLE`; cancellation remains the browser's `AbortError`. A
collection name or ID outside 1–64 ASCII letters, digits, underscores and
hyphens throws `TypeError` before any request. Other invalid input is the
server's to refuse with a 400.

There are no automatic retries. A failed or interrupted response does not prove
that a write failed: retrying `add()` can create another document. Read back or
reconcile before retrying. Cursor pagination is not a snapshot: concurrent edits
can move records between pages, especially when sorting by `updatedAt`.
