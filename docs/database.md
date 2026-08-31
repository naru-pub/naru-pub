# Site databases (Naru Data v1)

Naru Data stores per-site collections of JSON documents in the control plane's existing PostgreSQL database. Static sites use a dependency-free browser ES module; owners manage data and collection permissions at `/database` in the control plane. No Rust proxy changes or separate database hostname are required.

## Setup

From `control-plane`, install dependencies and run `pnpm migrate` against your intended development database before starting the app. For production, run the migration as part of the normal deployment procedure before serving the new API. The migration adds `site_data_collections` and `site_data_documents`; it does not modify hosted files. Back up PostgreSQL before production migrations. Do not roll back the migration unless you intend to delete all site databases.

## Permissions

Every new collection defaults to `admin` read and `admin` write. Permissions are independent:

| Read  | Write | Behavior                                                          |
| ----- | ----- | ----------------------------------------------------------------- |
| admin | admin | Only the owner can access documents through the control plane.    |
| world | admin | Anyone can read; only the owner can change documents.             |
| admin | world | Anyone can write, but only the owner can read (e.g. submissions). |
| world | world | Anyone can read, create, replace, and delete documents.           |

“Admin” means the authenticated Naru site owner, not another Naru user or a global platform administrator. Only owners can create/delete collections or change rules. World write is **not append-only**: anyone knowing a document ID can replace or delete it, including in a write-only collection. It is unsuitable for untrusted guestbooks that need moderation or immutable submissions without further restrictions.

Public API calls deliberately ignore cookies. The browser SDK always sends `credentials: "omit"`. Admin requests use the existing owner session at the same-origin `/api/account/database` endpoint; mutations require a matching `Origin`. Cross-origin admin login/delegation and admin credentials in hosted JavaScript are not supported. Never embed an owner session or secret in a public site.

## Browser SDK

Create a collection in the control plane, choose its permissions, then use this in a static page. Replace `https://naru.pub` with the control plane origin when running elsewhere. Custom-domain sites can use the same absolute import; both the SDK and public API support CORS.

```html
<script type="module">
  import {
    createDatabase,
    NaruDataError,
  } from "https://naru.pub/sdk/naru-data.js";
  const db = createDatabase({ site: "your-login-name" });
  const entries = db.collection("guestbook");

  try {
    const { id } = await entries.add({ name: "Visitor", message: "Hello!" });
    const document = await entries.get(id);
    await entries.set(id, { name: "Visitor", message: "Updated!" });
    const { documents, nextCursor } = await entries.list({ limit: 20 });
    if (nextCursor) {
      const nextPage = await entries.list({ limit: 20, after: nextCursor });
    }
    await entries.delete(id);
  } catch (error) {
    if (error instanceof NaruDataError)
      console.error(error.status, error.message);
    else console.error(error);
  }
</script>
```

`get` returns `{ id, data, updated_at }`; a missing document throws a 404 error. `set` replaces the whole document or creates it if absent. `add` generates a UUID and returns only `{ id }`, without requiring read permission. `delete` is idempotent. JSON null is stored as a value, not treated as deletion. Render user data with `textContent`, not `innerHTML`.

SDK declarations are available alongside the module at `/sdk/naru-data.d.ts`. Set `baseUrl` explicitly if bundling/copying the SDK rather than importing it from the control plane.

## HTTP API

Public root: `/api/data/:site`. Admin root: `/api/account/database` (site derived from the session).

| Method | Path relative to root            | Body / result                                            |
| ------ | -------------------------------- | -------------------------------------------------------- |
| GET    | `/`                              | Admin only: `{ collections }`                            |
| POST   | `/`                              | Admin only: `{ name, read?, write? }` creates collection |
| PATCH  | `/:collection`                   | Admin only: `{ read, write }` replaces permissions       |
| DELETE | `/:collection`                   | Admin only: deletes collection and its documents         |
| GET    | `/:collection?limit=50&after=id` | `{ documents, nextCursor }`                              |
| POST   | `/:collection`                   | `{ data }` creates document; returns `{ id }`            |
| GET    | `/:collection/:id`               | `{ document }`                                           |
| PUT    | `/:collection/:id`               | `{ data }` replaces document; returns `{ id }`           |
| DELETE | `/:collection/:id`               | `{ success: true }`                                      |

All JSON request bodies require `Content-Type: application/json`. Errors return `{ error }` with an HTTP status (400 invalid input, 401 no admin session, 403 denied, 404 missing, 409 duplicate/quota, 413 oversized, 415 wrong content type). Public preflight needs no authentication. Responses are not cached.

## Limits and consistency

- 100 collections, 10,000 documents, and 10 MiB of serialized JSON per site, separate from the hosted-file quota.
- Maximum request body: 64 KiB, including the `{ data }` envelope; enforced while streaming, even without Content-Length.
- Collection names and document IDs: 1–64 ASCII letters, numbers, underscores or hyphens.
- Pages: 1–100 documents (default 50), ordered by ID under the database collation. Pass the returned cursor; pagination is not a snapshot across concurrent changes.
- PostgreSQL JSONB semantics apply, including JavaScript number precision and no significant object key order.
- Owner-row locks serialize permission checks, writes, and quota checks across server processes. Deletes free quota; account deletion cascades through collections and documents.
- Writes are atomic and last-write-wins. No realtime subscriptions, offline persistence, custom indexes/queries, compare-and-set, SDK transactions, per-document rules, end-user accounts, or append-only permissions in v1.

World access intentionally permits callers from any origin; CORS is not authorization or abuse protection. Storage quotas bound retained data but do not rate-limit traffic. Configure edge request-rate and body limits for `/api/data/*` before enabling public writes in production. PostgreSQL backups must include these new tables; the existing hosted-file export does not include database records.

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

Integration tests require an empty database named exactly `naru_data_test`. They cover all permission combinations, isolation, pagination, replacement, cascading deletion, and concurrent quota enforcement. HTTP tests cover cookie isolation, same-origin admin protection, authentication and preflight; SDK tests cover CRUD transport and errors. The dedicated Jest config avoids obsolete global Lucia and Request mocks in the existing test setup.
