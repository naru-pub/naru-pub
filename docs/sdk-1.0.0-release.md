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

Tests cover CRUD request isolation, automatic Client ID discovery, PKCE/state and
callback expiry, one-time concurrent completion, restoration without extending
expiry, revocation, offline logout, storage denial, failed token persistence,
JSON/schema validation, atomic batch encoding, upload metadata, non-JSON HTTP
errors, network failures, sorting/filter encoding, and generic declaration usage.
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
- Obtain the owner's instruction to freeze 1.0.0. Then remove its development
  notice, record release notes and checksums, and tag the exact verified commit.
  Future SDK changes must use a new versioned directory after that freeze.

## Operational limitations

Logout invalidates the in-memory client and attempts to clear browser storage
before server revocation. If storage access is blocked, persisted bytes may remain;
if the network also fails, a copied token can remain usable until expiration or
control-plane revocation. The SDK cannot guarantee remote logout while offline.
An admin session is scoped to a browser tab and callback path; sessionStorage
may be copied by the browser when a tab is duplicated. It is not an XSS defense.
