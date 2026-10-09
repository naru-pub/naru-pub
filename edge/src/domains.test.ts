import { beforeEach, describe, expect, test } from "vitest";
import {
  domainSite,
  invalidTable,
  storeDomains,
  type DomainTable,
  type DomainsEnv,
} from "./domains";

// The custom domain table against KV held in memory.

let stored: string | null = null;
const env: DomainsEnv = {
  DOMAINS: {
    async get() {
      return stored === null ? null : JSON.parse(stored);
    },
    async put(_key: string, value: string) {
      stored = value;
    },
  } as unknown as KVNamespace,
};
const hour = 60 * 60 * 1000;

beforeEach(async () => {
  // Storing clears what the module remembers; then KV is emptied.
  await storeDomains(env, { confirmedUntil: 0, domains: {} });
  stored = null;
});

describe("serving", () => {
  test("serves a listed domain's site while its owner is paid up", async () => {
    await storeDomains(env, {
      confirmedUntil: Date.now() + hour,
      domains: {
        "example.com": { login: "alice", entitledUntil: null },
        "lapsing.example": { login: "bob", entitledUntil: Date.now() + hour },
        "lapsed.example": { login: "carol", entitledUntil: Date.now() - 1 },
      },
    });
    expect(await domainSite("Example.COM.", env)).toBe("alice");
    expect(await domainSite("lapsing.example", env)).toBe("bob");
    expect(await domainSite("lapsed.example", env)).toBeNull();
    expect(await domainSite("unknown.example", env)).toBeNull();
  });

  test("serves nothing from a table past its confirmation, or without one", async () => {
    expect(await domainSite("example.com", env)).toBeNull();
    await storeDomains(env, {
      confirmedUntil: Date.now() - 1,
      domains: { "example.com": { login: "alice", entitledUntil: null } },
    });
    expect(await domainSite("example.com", env)).toBeNull();
  });
});

describe("validation", () => {
  const table = (domains: DomainTable["domains"]) => ({
    confirmedUntil: Date.now(),
    domains,
  });

  test("accepts a well-formed table", () => {
    expect(
      invalidTable(
        table({ "www.example.co.kr": { login: "a-b", entitledUntil: 1 } }),
      ),
    ).toBeNull();
  });

  test.each([
    [null],
    [{ domains: {} }],
    [{ confirmedUntil: 1.5, domains: {} }],
    [table({ "Example.com": { login: "a", entitledUntil: null } })],
    [table({ "example..com": { login: "a", entitledUntil: null } })],
    [table({ "example.com": { login: "Bad", entitledUntil: null } })],
    [table({ "example.com": { login: "a", entitledUntil: "soon" as never } })],
  ])("refuses %j", (input) => {
    expect(invalidTable(input)).not.toBeNull();
  });
});
