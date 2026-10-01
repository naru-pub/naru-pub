import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { dispatchActorUpdate } from "@/lib/federation";
import { s3Client } from "@/lib/s3";
import { templateFileKey, templatePreviewKey } from "@/lib/board/preview";
import {
  getHomepageUrl,
  getRenderedSiteUrl,
  getSiteScreenshotKey,
} from "@/lib/site-urls";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Browser, chromium } from "playwright";

// Usage:
//   pnpm exec tsx src/cli/update-screenshots.tsx
//     → render all discoverable users whose site was updated after the last
//       render (the cron path)
//   pnpm exec tsx src/cli/update-screenshots.tsx --user <login_name>
//     → render a single user, still gated by the same predicate
//   pnpm exec tsx src/cli/update-screenshots.tsx --force
//     → render every discoverable user, ignoring the predicate
//   pnpm exec tsx src/cli/update-screenshots.tsx --user <login_name> --force
//     → render that user, ignoring the predicate
//   pnpm exec tsx src/cli/update-screenshots.tsx --templates
//     → render only board template previews still waiting for one (cron runs
//       this as soon as a template is published)
//   pnpm exec tsx src/cli/update-screenshots.tsx --templates --force
//     → render every live template version's preview again
//   pnpm exec tsx src/cli/update-screenshots.tsx --concurrency 8
//     → override the default parallel-render worker count (default: 2)

// Each render holds an arbitrary user site open for ten seconds at 2x scale in
// its own renderer, and this runs on the host every other service shares. Six
// at once took the cron container from 64MB to 1.85GB. A run is normally a
// handful of sites; anything the timeout cuts off is picked up next time.
const DEFAULT_CONCURRENCY = 2;

type TargetUser = { id: string; login_name: string };

// Board templates waiting for a preview. A render that keeps failing stops
// being retried after a day.
const TEMPLATE_PREVIEW_WINDOW = sql<Date>`now() - interval '1 day'`;
const TEMPLATE_PREVIEWS_PER_RUN = 10;

type TargetTemplate = {
  version_id: string;
  template_id: string;
  version: number;
};

async function selectTemplateTargets(
  force: boolean,
): Promise<TargetTemplate[]> {
  let query = db
    .selectFrom("board_template_versions as v")
    .innerJoin("board_templates as t", "t.id", "v.template_id")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .select(["v.id as version_id", "v.template_id", "v.version"])
    .where("p.deleted_at", "is", null)
    .orderBy("v.created_at", "asc");
  if (!force) {
    query = query
      .where("v.preview_rendered_at", "is", null)
      .where("v.created_at", ">", TEMPLATE_PREVIEW_WINDOW)
      .limit(TEMPLATE_PREVIEWS_PER_RUN);
  }
  return await query.execute();
}

async function selectTargets(
  loginName: string | undefined,
  force: boolean,
): Promise<TargetUser[]> {
  let query = db
    .selectFrom("users")
    .select(["id", "login_name"])
    .where("discoverable", "=", true)
    .orderBy("site_updated_at", "desc");

  if (loginName) {
    query = query.where("login_name", "=", loginName);
  }

  if (!force) {
    query = query.where((eb) =>
      eb.or([
        eb("site_rendered_at", "is", null),
        eb("site_rendered_at", "<", eb.ref("site_updated_at")),
      ]),
    );
  }

  return await query.execute();
}

async function purgeCloudflareCache(url: string): Promise<void> {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const apiToken = process.env.CLOUDFLARE_USER_API_TOKEN;
  if (!zoneId || !apiToken) return;

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: [url] }),
      },
    );
    if (!res.ok) {
      console.error(
        `Cloudflare purge failed for ${url}: ${res.status} ${await res.text()}`,
      );
      return;
    }
    console.log(`Purged Cloudflare cache for ${url}`);
  } catch (err) {
    console.error(`Cloudflare purge error for ${url}: ${err}`);
  }
}

async function takeScreenshot(browser: Browser, url: string): Promise<Buffer> {
  // A context per site, closed whatever happens. One shared context kept every
  // site's cache and storage for the whole run, and a page whose goto timed out
  // was never closed, so its renderer stayed up until the browser did.
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 640, height: 480 });
    await page.goto(url, { timeout: 10 * 1000 });
    await page.waitForTimeout(10 * 1000);
    return await page.screenshot();
  } finally {
    await context.close();
  }
}

async function renderUser(browser: Browser, user: TargetUser): Promise<void> {
  const homepageUrl = getHomepageUrl(user.login_name);

  const screenshot = await takeScreenshot(browser, homepageUrl);

  if (screenshot.length === 0) {
    console.log(`Skipping ${user.login_name}: screenshot is 0 bytes`);
    return;
  }

  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: getSiteScreenshotKey(user.login_name),
      Body: screenshot,
      ContentType: "image/png",
    }),
  );
  console.log(`Uploaded screenshot for ${user.login_name}`);

  await db
    .updateTable("users")
    .set({ site_rendered_at: new Date() })
    .where("id", "=", user.id)
    .executeTakeFirst();

  await purgeCloudflareCache(getRenderedSiteUrl(user.login_name));
  await dispatchActorUpdate(user.id);
}

// Serves one template version's own files, the snapshot as published, on a
// loopback port for the duration of a render. Rendering the author's live
// site instead would show whatever is there now, or their whole home page
// for a template shared from the site root.
async function serveTemplate(target: TargetTemplate) {
  const rows = await db
    .selectFrom("board_template_files")
    .select(["path", "content_type"])
    .where("version_id", "=", target.version_id)
    .execute();
  const files = new Map<string, { body: Uint8Array; contentType: string }>();
  for (const row of rows) {
    const object = await s3Client.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: templateFileKey(target.template_id, target.version, row.path),
      }),
    );
    files.set(row.path, {
      body: await object.Body!.transformToByteArray(),
      contentType: row.content_type,
    });
  }

  const server = createServer((request, response) => {
    let path: string;
    try {
      path = decodeURIComponent(
        new URL(request.url ?? "/", "http://template").pathname,
      ).replace(/^\/+/, "");
    } catch {
      response.writeHead(400).end();
      return;
    }
    const file =
      files.get(path) ??
      files.get(path.endsWith("/") || !path ? `${path}index.html` : "") ??
      files.get(`${path}/index.html`);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "Content-Type": file.contentType })
      .end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // The page to open: the root's index.html, or else the shallowest one, or
  // else the first HTML file. Versions published before templates were
  // rooted at their files' own folder can hold only hello-world/index.html.
  const paths = [...files.keys()].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  const entry =
    paths.find(
      (path) => path === "index.html" || path.endsWith("/index.html"),
    ) ??
    paths.find((path) => /\.x?html?$/.test(path)) ??
    "";
  return {
    url: `http://127.0.0.1:${port}/${entry
      .replace(/(^|\/)index\.html$/, "$1")
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function renderTemplate(
  browser: Browser,
  target: TargetTemplate,
): Promise<void> {
  const served = await serveTemplate(target);
  let screenshot: Buffer;
  try {
    screenshot = await takeScreenshot(browser, served.url);
  } finally {
    await served.close();
  }
  if (screenshot.length === 0) {
    console.log(
      `Skipping template ${target.template_id}: screenshot is 0 bytes`,
    );
    return;
  }
  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: templatePreviewKey(target.template_id, target.version),
      Body: screenshot,
      ContentType: "image/png",
    }),
  );
  await db
    .updateTable("board_template_versions")
    .set({ preview_rendered_at: new Date() })
    .where("id", "=", target.version_id)
    .execute();
  console.log(
    `Uploaded preview for template ${target.template_id} v${target.version}`,
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      user: { type: "string" },
      force: { type: "boolean", default: false },
      templates: { type: "boolean", default: false },
      concurrency: { type: "string" },
    },
  });

  const concurrency = values.concurrency
    ? Math.max(1, Number.parseInt(values.concurrency, 10))
    : DEFAULT_CONCURRENCY;

  const targets = values.templates
    ? []
    : await selectTargets(values.user, values.force ?? false);
  // A run for one user renders only that user.
  const templateTargets = values.user
    ? []
    : await selectTemplateTargets((values.templates && values.force) ?? false);

  if (values.user && targets.length === 0) {
    console.error(
      `[update-screenshots] no such discoverable user: ${values.user}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[update-screenshots] ${targets.length} target(s), ${templateTargets.length} template(s), concurrency=${concurrency}`,
  );

  // Most runs, and most --templates runs, find nothing: skip Chromium then.
  if (targets.length === 0 && templateTargets.length === 0) return;

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    const launched = browser;

    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= targets.length) return;
        const user = targets[index];
        try {
          await renderUser(launched, user);
        } catch (error) {
          console.error(`Failed to render ${user.login_name}: ${error}`);
        }
      }
    };

    const workerCount = Math.min(concurrency, targets.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    for (const target of templateTargets) {
      try {
        await renderTemplate(launched, target);
      } catch (error) {
        console.error(
          `Failed to render template ${target.template_id}: ${error}`,
        );
      }
    }
  } finally {
    if (browser) await browser.close();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
