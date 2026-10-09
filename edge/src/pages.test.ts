import { describe, expect, test } from "vitest";
import {
  classify,
  decodePath,
  directoryRedirect,
  pageviewPath,
  resolvePath,
  servePage,
  siteOf,
  truncate,
  type PagesEnv,
} from "./pages";
import type { PageviewEvent } from "./pageview-log";

// The proxy's own cases (proxy/src/main.rs, proxy/src/pageviews.rs), so the
// edge and the proxy keep answering alike, and the handler against a bucket
// held in memory.

const env = (files: Record<string, string> = {}, sites = "*"): PagesEnv => ({
  PLATFORM_DOMAIN: "naru.pub",
  R2_PUBLIC_DOMAIN: "r2.naru.pub",
  EDGE_SITES: sites,
  SITE_FILES: {
    async get(key: string) {
      if (!(key in files)) return null;
      return {
        body: new Response(files[key]).body,
        httpMetadata: {
          contentType: key.endsWith(".json") ? "application/json" : "text/html",
        },
      };
    },
  } as unknown as R2Bucket,
});

describe("hosts", () => {
  test("serves the sites it is given, by login", () => {
    expect(siteOf("alice.naru.pub", env())).toBe("alice");
    expect(siteOf("Alice.Naru.Pub.", env())).toBe("alice");
    expect(siteOf("alice.naru.pub", env({}, "bob, alice"))).toBe("alice");
    expect(siteOf("carol.naru.pub", env({}, "bob,alice"))).toBeNull();
    expect(siteOf("alice.naru.pub", env({}, ""))).toBeNull();
  });

  test("leaves the platform's own hosts and other names to the origin", () => {
    for (const host of [
      "naru.pub",
      "r2.naru.pub",
      "edge.naru.pub",
      "site-data.naru.pub",
      "custom-domains.naru.pub",
      "a.b.naru.pub",
      "_mta-sts.naru.pub",
      "bad--name.naru.pub",
      "limeburst.net",
      "alice.naru.pub.evil.example",
    ])
      expect(siteOf(host, env())).toBeNull();
  });
});

describe("paths", () => {
  test("resolves directories to their index", () => {
    for (const [path, file] of [
      ["", "index.html"],
      ["index.html", "index.html"],
      ["about/", "about/index.html"],
      ["foo/bar/", "foo/bar/index.html"],
      ["about", "about/index.html"],
      ["foo/bar", "foo/bar/index.html"],
      ["file.html", "file.html"],
      ["script.js", "script.js"],
      ["data.json", "data.json"],
      ["path/to/file.html", "path/to/file.html"],
      ["my.site/about", "my.site/about/index.html"],
      ["v1.0/docs", "v1.0/docs/index.html"],
      [".hidden", ".hidden/index.html"],
      ["path/.env", "path/.env/index.html"],
      ["file.", "file./index.html"],
    ])
      expect(resolvePath(path)).toBe(file);
  });

  test("decodes percent escapes as bytes, and invalid UTF-8 as the root", () => {
    expect(decodePath("%EB%B8%94%EB%A1%9C%EA%B7%B8")).toBe("블로그");
    expect(decodePath("a%3Fb%23c")).toBe("a?b#c");
    expect(decodePath("100%")).toBe("100%");
    expect(decodePath("%zz/a+b")).toBe("%zz/a+b");
    expect(decodePath("%FF")).toBe("");
  });

  test("redirects a directory to its slash, keeping the URL and query", () => {
    for (const [url, decoded, expected] of [
      ["/blog", "blog", "/blog/"],
      [
        "/nested/blog?page=2&tag=a%2Fb",
        "nested/blog",
        "/nested/blog/?page=2&tag=a%2Fb",
      ],
      [
        "/%EB%B8%94%EB%A1%9C%EA%B7%B8",
        "블로그",
        "/%EB%B8%94%EB%A1%9C%EA%B7%B8/",
      ],
      ["/a%3Fb%23c", "a?b#c", "/a%3Fb%23c/"],
      ["/blog%2F", "blog/", "/blog%2F/"],
      ["/blog?", "blog", "/blog/?"],
    ])
      expect(
        directoryRedirect(new URL(url, "https://alice.naru.pub"), decoded),
      ).toBe(expected);
  });

  test("leaves files and canonical URLs alone", () => {
    for (const [url, decoded] of [
      ["/", ""],
      ["/blog/", "blog/"],
      ["/blog/?page=2", "blog/"],
      ["/index.html", "index.html"],
      ["/blog/index.html", "blog/index.html"],
      ["/blog/app.js", "blog/app.js"],
    ])
      expect(
        directoryRedirect(new URL(url, "https://alice.naru.pub"), decoded),
      ).toBeNull();
  });

  test("counts a page under its directory", () => {
    expect(pageviewPath("")).toBe("/");
    expect(pageviewPath("index.html")).toBe("/");
    expect(pageviewPath("blog/")).toBe("/blog");
    expect(pageviewPath("blog/index.html")).toBe("/blog");
    expect(pageviewPath("blog/post.html")).toBe("/blog/post.html");
  });
});

describe("pageviews", () => {
  const request = (headers: Record<string, string>, method = "GET") =>
    new Request("https://alice.naru.pub/", { method, headers });

  test("classifies navigation intent from Fetch Metadata alone", () => {
    const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    expect(classify(request(nav))).toBe("navigation");
    expect(classify(request(nav, "POST"))).toBe("background");
    expect(
      classify(
        request({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }),
      ),
    ).toBe("frame");
    expect(classify(request({ "sec-fetch-mode": "navigate" }))).toBe("unknown");
    expect(classify(request({}))).toBe("unknown");
    expect(
      classify(
        request({ "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }),
      ),
    ).toBe("background");
  });

  test("truncates metadata to 2048 bytes on a character boundary", () => {
    expect(truncate(null)).toBeNull();
    expect(truncate("short")).toBe("short");
    expect(new TextEncoder().encode(truncate("a".repeat(3000))!)).toHaveLength(
      2048,
    );
    // "가" is three bytes: 682 of them fill 2046 of 2048.
    expect(truncate("가".repeat(1000))).toBe("가".repeat(682));
  });
});

describe("serving", () => {
  const files = {
    "alice/index.html": "<h1>home</h1>",
    "alice/blog/index.html": "<h1>blog</h1>",
    "alice/data.json": "{}",
  };
  const visit = async (path: string, headers: Record<string, string> = {}) => {
    const events: PageviewEvent[] = [];
    const response = await servePage(
      new Request(`https://alice.naru.pub${path}`, { headers }),
      env(files),
      "alice",
      (event) => events.push(event),
    );
    return { response, events };
  };
  const navigation = {
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "cf-connecting-ip": "203.0.113.7",
    referer: "https://example.com/",
    "user-agent": "test",
  };

  test("serves a page from the site's prefix and counts a navigation", async () => {
    const { response, events } = await visit("/", navigation);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>home</h1>");
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, stale-if-error=86400",
    );
    expect(events).toEqual([
      {
        login: "alice",
        timestamp: expect.any(Number),
        path: "/",
        ip: "203.0.113.7",
        referrer: "https://example.com/",
        userAgent: "test",
      },
    ]);
  });

  test("counts no request that is not a navigation to a page", async () => {
    expect((await visit("/")).events).toEqual([]);
    expect((await visit("/data.json", navigation)).events).toEqual([]);
    const { response, events } = await visit("/blog", navigation);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/blog/");
    expect(events).toEqual([]);
  });

  test("redirects other files to the bucket's public domain", async () => {
    const { response } = await visit("/images/cat.png");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://r2.naru.pub/alice/images/cat.png",
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-if-error=86400",
    );
  });

  test("answers a missing page 404, uncached", async () => {
    const { response } = await visit("/nowhere/", navigation);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // As the proxy: no type on its plain answers.
    expect(response.headers.get("content-type")).toBeNull();
  });

  test("answers a bucket failure 502, never 404", async () => {
    const failing = env();
    failing.SITE_FILES = {
      get: () => Promise.reject(new Error("down")),
    } as unknown as R2Bucket;
    const response = await servePage(
      new Request("https://alice.naru.pub/"),
      failing,
      "alice",
      () => {},
    );
    expect(response.status).toBe(502);
  });
});
