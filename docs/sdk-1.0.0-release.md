# SDK 1.0.0 release checks

The 1.0.0 SDK is still mutable at the owner's request. This checklist does not
freeze, publish, or tag it. Keep the fixed `https://naru.pub` control-plane origin
and versioned SDK URL; do not restore the unversioned URL.

## Local verification

From `control-plane`:

```sh
node --experimental-vm-modules --test tests/naru-data-sdk.test.mjs tests/database-blog.test.mjs
pnpm exec tsc --noEmit
node tests/browser/serve-sdk.mjs
```

Open `http://127.0.0.1:3111/`, choose **Run checks**, and then **Check page reload**.
The fixture loads the actual local SDK and uses native browser sessionStorage,
URL encoding, and crypto. API responses and credentials are synthetic; it makes
no production writes. Stop the server afterward.

Tests cover site inference from the page address, CRUD request shape and cookie
isolation, list query encoding, server error codes with native network and abort
errors, cache bypass after a write (including a lost one), PKCE sign-in and
callback completion, session restore and expiry, 401 handling, sign-out that
never erases a newer session, batch encoding, direct-to-storage upload with
image shrinking, and the media listing. The browser fixture repeats the storage,
fetch and 401 checks natively and shrinks a real 4096 px PNG on a real canvas.
The blog tests exercise public browsing/guestbook and admin draft/publishing flows.

## Before freezing

- Run a live acceptance pass on an explicitly authorized test website: public
  reading, public create-only guestbook, administrator sign-in and post editing,
  reload, logout, expiry and control-plane revocation. Local mock browser tests
  do not replace this deployment check. Never modify the user's live blog merely
  to populate tests or widen its registration automatically.
- Review supported browser targets; native ESM, fetch, Web Crypto, and
  sessionStorage are required for administrator sign-in. No browser-version
  compatibility matrix has been certified by this pass.
- Confirm documented limits, equality-only filters, replacement writes,
  non-snapshot pagination, and no automatic write retries.
- Confirm the frozen shapes one last time, since a new versioned directory is
  the only way to change them afterwards. The surface is deliberately minimal:
  `collection()` with `get`, `list`, `add`, `set` and `delete`; `signIn()`;
  `ownerSession()` returning `expiresAt`, `collection()`, `batch()`,
  `files.upload / list / delete` and `signOut()`; and `NaruDataError`. Server
  metadata is camelCase (`createdAt`/`updatedAt`), `add` and `set` return
  `{ id, version, createdAt, updatedAt }`, `orderBy` is always a list of
  `[field, direction]` pairs, and `files.list()` returns a
  `{ files, nextPageToken }` page. Anything added later is added to the server
  contract too, so add it only when a site needs it.
- Obtain the owner's instruction to freeze 1.0.0. Then remove its development
  notice, record release notes and checksums, and tag the exact verified commit.
  Future SDK changes must use a new versioned directory after that freeze.

## Operational limitations

Logout clears browser storage before requesting server revocation. If storage access is blocked, persisted bytes may remain;
if the network also fails, a copied token can remain usable until expiration or
control-plane revocation. The SDK cannot guarantee remote logout while offline.
An admin session is scoped to a browser tab and callback path; sessionStorage
may be copied by the browser when a tab is duplicated. It is not an XSS defense.

## SDK/API integration checks

From `control-plane`, with PostgreSQL tools (`initdb`, `pg_ctl`, `createdb`)
installed locally:

```sh
pnpm test:sdk:integration
# If pg_config is not on PATH, select the PostgreSQL bin directory:
NARU_TEST_PG_BIN=/opt/homebrew/opt/postgresql@18/bin bash scripts/test-data-sdk.sh
```

The runner initializes a fresh temporary PostgreSQL cluster and the guarded
`naru_data_test` database, applies the shared test migrations, and stops and removes
the cluster on exit. It overrides `DATABASE_URL`; it does not use the application's
database. PostgreSQL listens only on a private Unix socket. The HTTP listener binds
to an ephemeral loopback port.

The published SDK sends real HTTP requests to the actual data/auth route handlers
and PostgreSQL. No service or response mocks are used. Coverage includes JSON and
server metadata, conditional writes, filtered cursor pagination and counts, owner
batch results and rollback, optional read parsing, media listing/paging/metadata
filtering and patching, and token revocation. Browser
Origin and sessionStorage are supplied by a small shim, and owner credentials are
issued through the real authorization service during setup. This is a contract
test, not an end-to-end browser login or object-storage upload test.

To run all data suites against the same disposable cluster instead:

```sh
bash scripts/test-data-sdk.sh src/lib/site-data/__tests__
```
