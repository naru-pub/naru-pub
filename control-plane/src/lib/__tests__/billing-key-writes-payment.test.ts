import { describe, expect, test } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

// Billing keys never expire at Toss and are stored in plain text, so a key
// that leaves subscriptions.toss_billing_key must be queued for deletion at
// Toss first (lib/billing-keys.ts, retireBillingKey). Deleting a user cascades
// to the subscription and takes the key with it, so that goes through
// lib/account-deletion.ts. Nothing in the database enforces either; these
// checks keep a new code path from quietly dropping a key.
const SRC = join(__dirname, "..", "..");
const STORES_KEY = /toss_billing_key\s*:\s*(?!null\b|string\b)[A-Za-z_$]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "__tests__" || name === "migrations"
        ? []
        : sourceFiles(path);
    }
    return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

function offenders(pattern: RegExp, allowed: string[]): string[] {
  return sourceFiles(SRC)
    .map((path) => relative(SRC, path))
    .filter((path) => !allowed.includes(path))
    .filter((path) => pattern.test(readFileSync(join(SRC, path), "utf8")));
}

describe("billing keys are only dropped through retireBillingKey", () => {
  test("nothing else clears or replaces toss_billing_key", () => {
    expect(
      offenders(/toss_billing_key\s*(:\s*null|=\s*null)/i, [
        "lib/billing-keys.ts",
      ]),
    ).toEqual([]);
  });

  // Setting a key is allowed only where a subscription has none: the
  // subscribe confirm stores the key Toss just issued. Replacing one must retire the old key.
  test("only confirm stores a new key", () => {
    expect(
      offenders(STORES_KEY, [
        "lib/billing-keys.ts",
        "lib/subscription-signup.ts",
      ]),
    ).toEqual([]);
  });

  test("users rows are only deleted through deleteUserRow", () => {
    expect(
      offenders(/deleteFrom\(\s*["']users["']\s*\)|delete\s+from\s+users\b/i, [
        "lib/account-deletion.ts",
      ]),
    ).toEqual([]);
  });

  test("the checks see the code they guard", () => {
    // A wrong path or pattern would make the tests above pass vacuously.
    expect(offenders(/toss_billing_key\s*:\s*null/, []).length).toBeGreaterThan(
      0,
    );
    expect(offenders(STORES_KEY, [])).toEqual(["lib/subscription-signup.ts"]);
    expect(offenders(/deleteFrom\(\s*["']users["']\s*\)/, [])).toEqual([
      "lib/account-deletion.ts",
    ]);
  });
});
