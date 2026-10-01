import { describe, expect, test } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

// Billing keys stay chargeable as long as their card, so a key that leaves
// its plan (subscriptions.billing_key_id) must be retired for deletion at
// Toss (lib/payments/billing-keys.ts, retireBillingKey), and the billing_keys rows are
// written only there. Deleting a user goes through lib/account-deletion.ts,
// which retires the account's keys first. Nothing in the database enforces
// these; the checks keep a new code path from quietly dropping a key.
const SRC = join(__dirname, "..", "..", "..");
const STORES_KEY = /billing_key_id\s*:\s*(?!null\b|string\b)[A-Za-z_$]/;

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
  test("nothing else clears billing_key_id", () => {
    expect(
      offenders(/billing_key_id\s*(:\s*null|=\s*null)/i, [
        "lib/payments/billing-keys.ts",
      ]),
    ).toEqual([]);
  });

  test("nothing else writes billing_keys", () => {
    expect(
      offenders(
        /(insertInto|updateTable|deleteFrom)\(\s*["']billing_keys["']\s*\)/,
        ["lib/payments/billing-keys.ts"],
      ),
    ).toEqual([]);
  });

  // Giving a plan a key is allowed only as it starts — the subscribe confirm
  // creates it with the key Toss just issued — or right after retiring the
  // old one, as a card change does.
  test("only confirm stores a new key", () => {
    expect(
      offenders(STORES_KEY, [
        "lib/payments/billing-keys.ts",
        "lib/payments/subscription-signup.ts",
      ]),
    ).toEqual([]);
  });

  // Paid time has one owner (lib/payments/paid-time.ts), and the money ledger one
  // writer (lib/payments/payment-ledger.ts).
  test("only lib/payments/paid-time.ts writes supporter_until", () => {
    expect(
      offenders(/supporter_until\s*:(?!\s*(Date|string)\b)/, [
        "lib/payments/paid-time.ts",
      ]),
    ).toEqual([]);
  });

  test("only lib/payments/payment-ledger.ts writes payment_transactions", () => {
    expect(
      offenders(/insertInto\(\s*["']payment_transactions["']\s*\)/, [
        "lib/payments/payment-ledger.ts",
      ]),
    ).toEqual([]);
  });

  // Ending a plan has one way (endPlan): its key, event and mail go with it.
  test("only endPlan ends a plan", () => {
    expect(
      offenders(/status:\s*"canceled"/, ["lib/payments/subscriptions.ts"]),
    ).toEqual([]);
    expect(offenders(/status:\s*"canceled"/, [])).toEqual([
      "lib/payments/subscriptions.ts",
    ]);
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
    expect(offenders(/billing_key_id\s*:\s*null/, []).length).toBeGreaterThan(
      0,
    );
    expect(offenders(/insertInto\(\s*["']billing_keys["']\s*\)/, [])).toEqual([
      "lib/payments/billing-keys.ts",
    ]);
    expect(offenders(STORES_KEY, [])).toEqual([
      "lib/payments/subscription-signup.ts",
    ]);
    expect(
      offenders(/supporter_until\s*:(?!\s*(Date|string)\b)/, []).sort(),
    ).toEqual(["lib/payments/paid-time.ts"]);
    expect(offenders(/deleteFrom\(\s*["']users["']\s*\)/, [])).toEqual([
      "lib/account-deletion.ts",
    ]);
  });
});
