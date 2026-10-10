# Production deployment

Production runs the images GitHub Actions builds. Every push to `main` runs
[`.github/workflows/main.yml`](../.github/workflows/main.yml) in
[naru-pub/naru](https://github.com/naru-pub/naru), which pushes:

```
ghcr.io/naru-pub/naru-control-plane:git-<commit>-arm64
ghcr.io/naru-pub/naru-control-plane-jobs:git-<commit>-arm64
```

The two images are targets of one multi-stage
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
them `naru-control-plane:<commit>` and
`naru-control-plane-jobs:<commit>`. Only `origin/main` is deployed, so push first. `./deploy-server.sh <commit>` on the
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
purpose: a Next.js build there ran the Docker VM that
every other service on the host shares out of memory.

`deploy-server.sh` uses blue-green HTTP deployments. A stable nginx gateway owns host
port `40000` (control plane). The blue and green application slots have no
published host ports. Hosted sites are not served from the host at all; the
edge Worker serves them ([below](#hosted-sites-at-the-edge)).

For each deployment, `deploy-server.sh`:

1. replaces its own copies of `deploy-server.sh` and `docker-compose.yml`
   with the ones committed at exactly the commit the images were built from;
2. pulls that commit's images from ghcr.io unless they are already loaded;
3. points the `:current` tags at that commit's images;
4. keeps the active web slot serving, stops the worker, and runs compatible
   database migrations from the new jobs image, then configures the pg_cron
   payment and maintenance schedules and enqueues catch-up tasks;
5. starts the inactive slot and waits for the control plane and database to
   become healthy;
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

The server holds no git checkout. Its directory (`~/naru`, where `deploy.sh`
looks for it as `REMOTE_DIR`) has only `.env`, `.deploy-state/`,
`deploy-server.sh` and `docker-compose.yml`. The script downloads the last two
from `raw.githubusercontent.com` at the commit being deployed (the repository
is public, so no credentials), then re-executes the new copy before it reads
the Compose topology. This keeps a deployment safe when the deployment script
or Compose file itself changes in that commit. It records the commit in
`.deploy-state/commit` and refuses one that GitHub's compare API does not
report as ahead of it, so an older release cannot go live by accident; use
rollback for that.

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
slot starts and passes its health checks. The stable gateway can remain
running, and hosted sites keep answering from the edge. Use this mode for schema changes that the old web
code cannot safely use; ordinary releases must be compatible with the schema
while the previous slot serves.

Runtime state is stored under `.deploy-state/` and must not be committed. If the
active-slot file is lost, inspect the nginx configuration and restore
`.deploy-state/active-slot` to `blue` or `green` before deploying again.

## Edge Worker

The edge Worker ([`edge/`](../edge), deployed as `naru-edge`) serves
hosted sites and the Data SDK's script, and keeps every site's database
([database.md](database.md#durable-objects-backend)). It is not part of the
images and deploys on its own: Cloudflare Workers Builds deploys it from
`main` (root directory `edge`), on an account on the Workers Paid plan. To set
it up, or deploy by hand from the development machine:

```bash
cd edge
pnpm install
pnpm exec wrangler login
pnpm run deploy
openssl rand -base64 32 | tr -d '\n' | pnpm exec wrangler secret put EDGE_WORKER_SECRET
```

Set `EDGE_WORKER_URL=https://edge.naru.pub` and the same
`EDGE_WORKER_SECRET` in the server's `.env`, then deploy the control
plane so application and background processes read them. Without these
settings, site database operations are unavailable. Change the secret in
both places together; private `/v1/sites/*` operations require it.

`wrangler.jsonc` declares the `edge.naru.pub` custom domain, the
public `naru.pub/api/data/v1/*` and `naru.pub/sdk/*` routes, and the
hosted-site routes below. The SDK route serves the committed
`control-plane/public/sdk/` files, which deploy with the Worker as its static
assets (`edge/src/sdk.ts`).
Cloudflare manages the custom domain's DNS and certificate. Both `workers.dev`
and Preview URLs are disabled. The public route handles every site; the
control plane does not manage per-site Worker routes. The `edge-sync`
maintenance job renews entitlements, sends the custom-domain table, and updates
usage counters every five minutes.

Deploy the Worker before a control plane that relies on what is new in it,
and redeploy it whenever `edge/` or the control-plane modules it
imports (`lib/site-data/validation.ts`, `filters.ts`, `pagination.ts`,
`protocol.ts`, `lib/uuid.ts`) change, and whenever the SDK's files
(`public/sdk/`, `sdk/aliases.json`) change: until then naru.pub serves the
previous SDK. A change to the object's tables must
create them compatibly with what existing objects already hold.

## Hosted sites at the edge

The same Worker serves hosted sites, `<login>.naru.pub`, straight from the
site bucket `naru-pub` (`edge/src/pages.ts`), so they keep working while the
Mac mini is down. Directories resolve to `index.html`; HTML, JS and JSON come
from the bucket; other files redirect (`302`) to
`https://r2.naru.pub/<login>/<path>`; a directory without its trailing slash
redirects (`308`) to it, keeping the query. A missing site or file is a `404`
and a bucket failure a `502`. It needs no database: a site's files are its
`<login>/` prefix, and deleting an account deletes them.

`r2.naru.pub` serves the whole site bucket, not only sites: any object is
public to whoever knows its key. What else lives there either is public on
purpose (`_templates/`, screenshots) or hides behind a random key:
home directory exports are `__exports/<128-bit token>/<login>-export.zip`,
reached through the presigned link in their email, and GitHub deploys stage
under `__deploy_uploads/<user id>/<deployment id>/`. Account deletion removes a
user's exports with their site, and the export job deletes any zip no export
row points at.

Pages carry `Cache-Control: public, max-age=0, stale-if-error=86400` and
redirects `public, max-age=3600, stale-if-error=86400`, for browsers: Worker
responses are not stored in Cloudflare's cache, so edits appear at once and
every pageview reaches the Worker.

Custom domains are served the same way. The control plane
(`control-plane/src/lib/edge/domains.ts`) sends the Worker the whole table of
domains it serves, through `/v1/domains/replace`: every domain active in
Cloudflare and verified whose owner is complimentary or paid up through the
grace period, mapped to the owner's login, with when that entitlement ends.
The Worker keeps it in KV (`DOMAINS`, one entry) and serves it until its
`confirmedUntil`, three days after the last push. `edge-sync` pushes
it every five minutes, and activating or deleting a domain pushes it at once.
Any host that is neither a site nor a listed custom domain gets a `404` from
the Worker.

Routes decide which requests reach the Worker. `wrangler.jsonc` declares
`*.naru.pub/*` for sites and `*/*`, which catches custom domains: they reach
the zone through Cloudflare for SaaS under their own hostnames. Those routes
would also catch the control plane and the bucket's public domains, so keep
them off with routes that have no Worker, created once (Workers Routes in the
zone dashboard, or the API with a `zone:workers_routes` token):

```bash
for host in naru.pub r2.naru.pub media.naru.pub; do
  curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data "{\"pattern\": \"$host/*\"}"
done
```

The more specific `naru.pub/api/data/v1/*` and `naru.pub/sdk/*` still go to
the Worker, and the
Worker's custom domain `edge.naru.pub` takes precedence over every route.

The Worker reads the bucket through its `SITE_FILES` binding, so it deploys
with a token that can read R2 (Workers Builds' does).

Pageviews go to the Worker's pageview log, one Durable Object, and the
`edge-pageview-drain` job moves them into the pageview tables every minute
([pageview analytics](design/pageview-analytics.md)). While the control plane
is down they wait there, up to six million, and are counted when it is back;
the `edge_pageview_cursors` row keeps a batch from being counted twice. The
job fails, and alerts like any failed job, once the oldest waiting pageview is
more than 30 minutes old.

After a file edit the control plane purges the file's
`https://r2.naru.pub/<login>/<path>` URL (`control-plane/src/lib/cache-purge.ts`);
hosted HTML, JS and JSON are not cached, so nothing else needs purging.

## Former cache rule for hosted sites

The zone's `Hosted site fallback` Cache Rule (Caching → Cache Rules) gave the
retired hosted-site proxy's pages a one-day `stale-if-error` fallback. Worker
responses bypass the cache, so the rule no longer has any effect and can be
deleted from the dashboard. Always Online no longer matters for hosted sites
either.

## Public data caching

The edge Worker caches anonymous reads of world-readable collections
for ten seconds using Cloudflare's Cache API. A zone Cache Rule is not needed
for these Worker responses. The former `Public site data reads` rule can be
removed from the zone configuration.

Owner requests, writes, errors, and `fresh=1` reads are never cached. The SDK
uses `fresh=1` after its own writes for the loaded module's lifetime. Permission
changes may take up to ten seconds to hide previously cached public data.

## Federation worker shutdown

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

Pageview analytics require the postgresql-hll extension, which keeps distinct
visitors as HyperLogLog sketches ([pageview analytics](design/pageview-analytics.md)).
It needs no preloading; a migration creates it, so the application role must be
allowed to (production's is a superuser). Production's Homebrew PostgreSQL has
it from `brew install postgresql-hll`; on Debian or Ubuntu the package is
`postgresql-<major>-hll`, which CI installs.

The application cron service is retired. The deployment script stops and removes
its old container before migration, preserving database task state. Maintenance
tasks have separate Absurd capacity and stop their child scripts on shutdown so
unfinished attempts can retry. See [the cron replacement](design/cron-replacement.md).
