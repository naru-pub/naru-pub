#!/usr/bin/env node
// Compares the edge's answer for hosted-site URLs with the proxy's, while
// sites move to the edge (EDGE_SITES in wrangler.jsonc). Each URL is fetched
// twice: as is, which the edge answers for a site it serves, and with
// `x-naru-origin: 1`, which the Worker sends on to the proxy. Status,
// Location, Content-Type and a hash of the body must match.
//
//   node scripts/compare-pages.mjs < urls.txt
//
// One URL per line. The requests carry no Fetch Metadata, so neither side
// counts them as pageviews.
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

async function answer(url, origin) {
  const response = await fetch(url, {
    redirect: "manual",
    headers: origin ? { "x-naru-origin": "1" } : {},
  });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    location: response.headers.get("location"),
    type: response.headers.get("content-type"),
    body: createHash("sha256").update(body).digest("hex").slice(0, 16),
  };
}

let compared = 0;
let differing = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const url = line.trim();
  if (!url) continue;
  const [edge, origin] = await Promise.all([
    answer(url, false),
    answer(url, true),
  ]);
  compared += 1;
  const fields = Object.keys(edge).filter((key) => edge[key] !== origin[key]);
  if (fields.length) {
    differing += 1;
    console.log(`DIFF ${url}`);
    for (const key of fields)
      console.log(`  ${key}: edge ${edge[key]} / proxy ${origin[key]}`);
  }
}
console.log(`${compared} compared, ${differing} differing`);
if (differing) process.exitCode = 1;
