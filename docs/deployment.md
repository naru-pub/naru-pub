# Production deployment

`deploy.sh` uses blue-green HTTP deployments. A stable nginx gateway owns host
ports `40000` (control plane) and `40001` (hosted-site proxy). The blue and green
application slots have no published host ports.

For each deployment, the script:

1. pulls the latest commit with a fast-forward-only pull;
2. builds the inactive control-plane and site-proxy slot;
3. runs database migrations from the new control-plane image;
4. starts the inactive slot and waits for the control plane, database, and
   hosted-site proxy to become healthy;
5. reloads nginx to atomically direct new requests to the healthy slot; and
6. recreates the cron and worker processes from the new image.

The previous HTTP slot stays running after the switch. Existing nginx workers
can finish in-flight requests against it, and it remains available for an
immediate traffic rollback:

```bash
./deploy.sh rollback
```

Rollback only switches the HTTP services. It does not reverse database
migrations or roll back cron and worker code. Migrations deployed through this
flow must therefore use the expand-and-contract pattern: first add compatible
schema, deploy code that can use it, and remove old schema only in a later
deployment after rollback is no longer required.

The first deployment from the legacy Compose topology has a short one-time
cutover while the stable gateway takes ownership of ports `40000` and `40001`.
Subsequent deployments keep the gateway and active slot running throughout. A
rollback slot first becomes available after the second blue-green deployment.

Runtime state is stored under `.deploy-state/` and must not be committed. If the
active-slot file is lost, inspect the nginx configuration and restore
`.deploy-state/active-slot` to `blue` or `green` before deploying again.
