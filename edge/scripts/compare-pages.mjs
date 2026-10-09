#!/usr/bin/env node
// Compares the edge's answer for hosted-site URLs with the proxy's, while
// sites move to the edge (EDGE_SITES in wrangler.jsonc). Each URL is fetched
// twice: as is, which the edge answers for a site it serves, and with
// `x-naru-origin: 1`, which the Worker sends on to the proxy. Status,
// Location, Content-Type and a hash of the body must match.
//
//   node scripts/compare-pages.mjs < urls.txt
//
// One URL per line, compared sixteen at a time, each request given twenty
// seconds. The requests carry no Fetch Metadata, so neither side counts them
// as pageviews. Pages served by the proxy pass through Cloudflare's email
// obfuscation and the edge's do not, so a body that differs only there is
// reported as such rather than as a difference.
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const CONCURRENCY = 16;
const TIMEOUT_MS = 20_000;
const OBFUSCATED = "/cdn-cgi/l/email-protection";

async function answer(url, origin) {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      headers: origin ? { "x-naru-origin": "1" } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      location: response.headers.get("location"),
      type: response.headers.get("content-type"),
      body: createHash("sha256").update(body).digest("hex").slice(0, 16),
      obfuscated: body.includes(OBFUSCATED),
    };
  } catch (error) {
    return { status: `failed (${error.name})` };
  }
}

const urls = [];
for await (const line of createInterface({ input: process.stdin }))
  if (line.trim()) urls.push(line.trim());

const counts = { compared: 0, differing: 0, obfuscation: 0 };
async function compare(url) {
  const [edge, origin] = await Promise.all([
    answer(url, false),
    answer(url, true),
  ]);
  counts.compared += 1;
  const fields = ["status", "location", "type", "body"].filter(
    (key) => edge[key] !== origin[key],
  );
  if (!fields.length) return;
  if (fields.length === 1 && fields[0] === "body" && origin.obfuscated) {
    counts.obfuscation += 1;
    return;
  }
  counts.differing += 1;
  console.log(`DIFF ${url}`);
  for (const key of fields)
    console.log(`  ${key}: edge ${edge[key]} / proxy ${origin[key]}`);
}

let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < urls.length) await compare(urls[next++]);
  }),
);
console.log(
  `${counts.compared} compared, ${counts.differing} differing` +
    (counts.obfuscation
      ? `, ${counts.obfuscation} differing only by email obfuscation`
      : ""),
);
if (counts.differing) process.exitCode = 1;
