# Production deployment

Production runs the images GitHub Actions builds. Every push to `main` runs
[`.github/workflows/main.yml`](../.github/workflows/main.yml) in
[naru-pub/naru-pub](https://github.com/naru-pub/naru-pub), which pushes:

```
ghcr.io/naru-pub/naru-pub-control-plane:git-<commit>-arm64
ghcr.io/naru-pub/naru-pub-control-plane-jobs:git-<commit>-arm64
ghcr.io/naru-pub/naru-pub-proxy:git-<commit>-arm64
```

The two control-plane images are targets of one multi-stage
[`control-plane/Dockerfile`](../control-plane/Dockerfile). `control-plane` is
the Next.js server built with `output: "standalone"`: only the files the server
uses, without Chromium, pnpm, devDependencies or the build cache. The blue and
green slots run it. `control-plane-jobs` has the CLIs and migrations compiled
to `dist/` by `scripts/build-cli.mjs`, only the dependencies those import (not
Next, React or the other web app packages, which the build refuses), and
Chromium; `worker` and migrations run from it with plain `node`, no
`tsx`.

To deploy, push to `main` and run this from the development machine:

```bash
mise run deploy        # same as ./deploy.sh
```

It resolves `origin/main`, waits with `gh` for that commit's CI run to succeed,
and runs `deploy-server.sh <commit>` on the host named by the `naru-pub-deploy`
alias in `~/.ssh/config`. The server pulls the images from ghcr.io and tags
them `naru-pub-control-plane:<commit>`, `naru-pub-control-plane-jobs:<commit>`
and `naru-pub-proxy:<commit>`. Only
`origin/main` is deployed, so push first. `./deploy-server.sh <commit>` on the
server does the same deployment without the CI wait.

This path is meant for a metered connection such as a phone hotspot. The
development machine reads one ref with `git ls-remote`, polls the run's status
every `CI_POLL_SECONDS` (30 by default), and sends one ssh command. The images,
several GB, go from ghcr.io to the server and never through the development
machine.

The packages are private, so the server pulls with its own `docker login
ghcr.io`, using a classic personal access token with only the `read:packages`
scope. Docker on the server must keep that login in `~/.docker/config.json`
rather than the macOS keychain, because the ssh session `deploy.sh` uses
cannot unlock the keychain. Set it up once on the server:

```bash
jq 'del(.credsStore)' ~/.docker/config.json > ~/.docker/config.json.new && mv ~/.docker/config.json.new ~/.docker/config.json
docker login ghcr.io -u yangnaru
```

Removing `credsStore` alone is not enough when `auths` is empty: Docker then
falls back to the keychain again. An existing `ghcr.io` entry, which a
keychain login leaves behind, is enough to keep it on the file. Log in again
the same way when the token expires.

CI builds with the Dockerfile's default `NEXT_PUBLIC_DOMAIN` (`naru.pub`), which
is compiled into the client bundle. If the server's `.env` ever sets a
different value, deploy with the manual build below instead.

### Manual build

When CI is unavailable, or an image has to be built from this machine, run:

```bash
mise run deploy:local  # same as ./deploy.sh build
```

It builds the images from `origin/main` in a clean checkout of its own
(`~/.cache/naru-pub-deploy`), using the server's `NEXT_PUBLIC_*` values, ships
them over ssh, and runs the same `deploy-server.sh <commit>`. The server then
finds the images already loaded and pulls nothing. Docker must be running on
the development machine, and it uploads the compressed images from there, so
avoid it on a metered connection.

Neither path compiles on the server, and its Compose file has no `build:` on
purpose: a Next.js build and a release Cargo build there ran the Docker VM that
every other service on the host shares out of memory.

`deploy-server.sh` uses blue-green HTTP deployments. A stable nginx gateway owns host
ports `40000` (control plane) and `40001` (hosted-site proxy). The blue and green
application slots have no published host ports.

For each deployment, `deploy-server.sh`:

1. fast-forwards the server checkout to exactly the commit the images were
   built from;
2. pulls that commit's images from ghcr.io unless they are already loaded;
3. points the `:current` tags at that commit's images;
4. keeps the active web slot serving, stops the worker, and runs compatible
   database migrations from the new jobs image, then configures the pg_cron
   payment and maintenance schedules and enqueues catch-up tasks;
5. starts the inactive slot and waits for the control plane, database, and
   hosted-site proxy to become healthy;
6. reloads nginx to atomically direct new requests to the healthy slot;
7. recreates the worker process from the new jobs image; and
8. stops the previous slot and removes release images nothing can come back to.

Ordinary deployments keep the active control plane serving until the new slot
is healthy and traffic switches. For a breaking migration, run
`DEPLOY_DOWNTIME=1 ./deploy.sh` (or set the same variable when running
`deploy-server.sh` directly). This stops both web slots as well as background
processes before migration. Backward compatibility is not required for these
explicit cutovers; downtime remains acceptable when needed (see `AGENTS.md`). The Absurd payment migration imports existing work and
removes the old queue; see [the payment deployment notes](design/absurd-payments.md#deployment).

After the checkout moves, the script re-executes the checked-in copy once
before it reads the Compose topology. This keeps a deployment safe when the
deployment script or Compose file itself changes in that commit.

The previous HTTP slot is stopped once traffic has left it. nginx finishes
in-flight requests on its old workers after a reload, so the script waits for
those workers to exit (at most `DRAIN_TIMEOUT_SECONDS`, 120 by default) before
stopping the slot. Its containers are kept, not removed, so an immediate
traffic rollback starts them again without a rebuild:

```bash
./deploy.sh rollback             # from the development machine
./deploy-server.sh rollback      # or on the server itself
```

A rollback starts the stopped slot, waits for it to become healthy, switches
traffic to it, and stops the slot it left. The slots use
`restart: unless-stopped`, so a stopped slot also stays stopped across a Docker
restart.

Rollback only switches HTTP services. It does not reverse database migrations
or roll back worker code. After a breaking migration, use a forward
fix; an older image may no longer work with the current schema. Backward
compatibility is not maintained solely to support rollback.

With `DEPLOY_DOWNTIME=1`, control-plane requests are unavailable until the new
slot starts and passes its health checks. The stable gateway and hosted-site
proxy can remain running. Use this mode for schema changes that the old web
code cannot safely use; ordinary releases must be compatible with the schema
while the previous slot serves.

Runtime state is stored under `.deploy-state/` and must not be committed. If the
active-slot file is lost, inspect the nginx configuration and restore
`.deploy-state/active-slot` to `blue` or `green` before deploying again.

## Site-data Worker (Durable Objects)

Sites moved off PostgreSQL keep their databases in the `naru-site-data` Worker
([`site-data-worker/`](../site-data-worker), see
[database.md](database.md#durable-objects-backend)). It is not part of the
images and deploys on its own, from the development machine, with an account
on the Workers Paid plan:

```bash
cd site-data-worker
pnpm install
pnpm exec wrangler login
pnpm run deploy
openssl rand -base64 32 | tr -d '\n' | pnpm exec wrangler secret put SITE_DATA_WORKER_SECRET
```

Then set `SITE_DATA_WORKER_URL` (the Worker's `workers.dev` address, or a
route of your own) and the same `SITE_DATA_WORKER_SECRET` in the server's
`.env`, and deploy the control plane so it reads them. Until then every site
stays on PostgreSQL and `site-data-move` refuses to run. The Worker only
answers requests carrying the secret, and the control plane is its only
caller; change the secret in both places together.

The control plane also adds and removes one Worker route per moved site,
`naru.pub/api/data/v1/<site>/*`, through the Cloudflare API with
`CLOUDFLARE_USER_API_TOKEN`, which needs **Zone → Workers Routes → Edit** on
the zone. Set `SITE_DATA_WORKER_NAME` only if the Worker is not named
`naru-site-data`. The `site-data-edge-sync` maintenance job puts back any route
that goes missing within five minutes, including after a `wrangler deploy`
(the routes are not in `wrangler.jsonc`); until then the control plane
answers the site, more slowly.

Deploy the Worker before a control plane that relies on what is new in it,
and redeploy it whenever `site-data-worker/` or the control-plane modules it
imports (`lib/site-data/validation.ts`, `filters.ts`, `pagination.ts`,
`protocol.ts`, `lib/uuid.ts`) change. A change to the object's tables must
create them compatibly with what existing objects already hold.

## Cloudflare cache rule for hosted sites

Hosted pages (HTML, JS and JSON served by the site proxy) carry
`Cache-Control: public, max-age=0, stale-if-error=86400`. Cloudflare stores
each page but revalidates it at the origin on every request, so edits appear
at once and pageviews are still counted. When the origin answers with a `5xx`,
Cloudflare serves the last good copy for up to a day instead. The proxy
therefore reports its own failures as `5xx`: `503` when PostgreSQL is
unreachable (after at most 3 seconds) and `502` when R2 fails. Only a missing
site or file is a `404`, which replaces the cached copy. Redirects to R2 and
to directory URLs are cached for an hour, with the same one-day fallback.

This only covers failures the origin can still answer: PostgreSQL or R2
outages, and both proxy slots being down (the nginx gateway returns `502`).
When the whole host or the tunnel is down, Cloudflare generates the error
itself (`530`/1033) and `stale-if-error` does not apply.

Cloudflare does not cache HTML or JSON by default, so the rule below is
required. Without it the header has no effect (`cf-cache-status: DYNAMIC`).
Custom domains use this zone's rules through Cloudflare for SaaS. Like the data
rule, it is zone configuration: recreate it by hand if the zone is rebuilt.

**Caching → Cache Rules → `Hosted site fallback`**

Expression (list every hostname that is not a hosted site). The R2 hosts must
stay out: their objects carry no `Cache-Control`, so this rule would stop them
being cached at all:

```
(not http.host in {"naru.pub" "r2.naru.pub" "media.naru.pub"})
```

| Setting                                | Value                                                    |
| -------------------------------------- | -------------------------------------------------------- |
| Cache eligibility                      | Eligible for cache                                       |
| Edge TTL                               | Use cache-control header if present, bypass cache if not |
| Browser TTL                            | Respect origin TTL                                       |
| Serve stale content while revalidating | Off                                                      |

Keep this rule after the zone's `Exclude CSS/ICO/JS from being cached` rules.
Later rules win, so hosted-site JS gets the fallback (the `max-age=0` header
keeps it fresh) while the exclusions still apply to `naru.pub` and R2.

**Always Online** (Caching → Configuration) must stay off, because Cloudflare
ignores `stale-if-error` while it is on.

Enable the rule only after the proxy that sends these headers is deployed. The
older proxy sends `max-age=3600`, and only URLs on the platform subdomain are
purged on edit, so an edited page on a custom domain would stay stale for up
to an hour.

Check it with a GET on a hosted page. The first request is `MISS`, later ones
are `REVALIDATED` or `EXPIRED`, never `DYNAMIC`:

```bash
curl -s -o /dev/null -D - "https://eyecntct.naru.pub/" | grep -iE 'cf-cache-status|cache-control'
```

## Cloudflare cache rule for public data reads

The site data API marks anonymous reads of `world`-readable collections
`Cache-Control: public, max-age=0, s-maxage=10`, but Cloudflare does not cache
API responses on its own. Without the rule below every visitor's read reaches
PostgreSQL. The rule is zone configuration, not code: recreate it by hand if the
`naru.pub` zone is ever rebuilt.

**Caching → Cache Rules → `Public site data reads`**

Expression:

```
(http.request.method eq "GET"
 and starts_with(http.request.uri.path, "/api/data/")
 and not len(http.request.headers["authorization"]) > 0)
```

| Setting                                | Value                                                    |
| -------------------------------------- | -------------------------------------------------------- |
| Cache eligibility                      | Eligible for cache                                       |
| Edge TTL                               | Use cache-control header if present, bypass cache if not |
| Browser TTL                            | Respect origin TTL                                       |
| Cache key                              | Defaults; the query string must stay part of the key     |
| Serve stale content while revalidating | Off                                                      |

The trailing slash in `/api/data/` keeps sign-in (`/api/data-auth/`) and the
control panel (`/api/account/database`) out. The origin decides what is actually
stored: requests with a token, admin-only collections, `/_files`, writes and
every error carry `no-store`, and anonymous public responses use
`Access-Control-Allow-Origin: *`, so ignoring `Vary` cannot hand one caller's
response to another. Stale serving stays off because the 10-second window is
also how long a collection just changed from `world` to `admin` can still be
served. The browser SDK reads a collection with `cache: "no-store"` and the private
`fresh=1` query parameter after its own write for the rest of the loaded module's lifetime. The server returns `no-store` for that query variant. Keep query
strings in the cache key and respect origin headers: this makes read-after-write
independent of the shared cache duration. A request with `fresh=1` must never
be a cache HIT.

Check it with GET requests; `curl -I` sends HEAD, which the expression does not
match and which always reports `DYNAMIC`:

```bash
curl -s -o /dev/null -D - "https://naru.pub/api/data/v1/eyecntct/posts?size=1" | grep -i cf-cache-status
```

Within 10 seconds a repeat is `HIT`, after that `EXPIRED`; with an
`Authorization` header it is `DYNAMIC`, and error responses are `BYPASS`.

The federation worker aborts its queue listener on SIGTERM, drains heartbeat
work, and closes both the postgres.js client and the shared Kysely pool before
exiting. The image smoke test checks that it exits cleanly within 20 seconds;
deployment still allows 300 seconds for genuinely running work to drain.

The existing worker process now hosts both Fedify and the continuous Absurd
payment worker. On ordinary deployments, the worker stops gracefully while
the active HTTP slot remains serving. The worker drains both listeners before
closing shared databases; Compose's stop grace period is five minutes. The image
smoke test verifies payment-worker startup, drain, and exit code zero. No queue
migration or separate worker service is required.

Payment and maintenance scheduling requires pg_cron installed and preloaded in PostgreSQL.
The deployment CLI connects to `cron.database_name`, creates the extension
there if necessary, and updates the named hourly job with
`cron.schedule_in_database`, targeting the application database and role.
That role needs permission to install/manage pg_cron in its metadata database,
and pg_cron needs database authentication to execute the command. Production
already preloads pg_cron, so this change needs no PostgreSQL restart.
Configuration failure stops deployment before the new background worker starts.

The application cron service is retired. The deployment script stops and removes
its old container before migration, preserving database task state. Maintenance
tasks have separate Absurd capacity and stop their child scripts on shutdown so
unfinished attempts can retry. See [the cron replacement](design/cron-replacement.md).
