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
      offenders(/billing_key_id\s*(:[^\n]*\bnull\b|=\s*null)/i, [
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

  test("signup HTTP paths never execute a charge", () => {
    expect(offenders(/\bchargeOrder\s*\(/, [])).toEqual([
      "lib/payments/payment-jobs.ts",
      "lib/payments/subscription-renewals.ts",
      "lib/payments/toss-gateway.ts",
    ]);
  });

  test("only the Absurd handler approves one-time payments", () => {
    expect(offenders(/\bconfirmOrder\s*\(/, [])).toEqual([
      "lib/payments/payment-jobs.ts",
      "lib/payments/toss-gateway.ts",
    ]);
    expect(offenders(/\bconfirmPayment\s*\(/, [])).toEqual([
      "lib/payments/toss-gateway.ts",
      "lib/payments/toss.ts",
    ]);
    expect(
      offenders(/\brenewSubscription\s*\(/, [
        "lib/payments/subscription-renewals.ts",
      ]),
    ).toEqual(["lib/payments/payment-jobs.ts"]);
    expect(offenders(/\bchargeDueSubscriptions\b/, [])).toEqual([]);
    expect(offenders(/\bchargeBillingKey\s*\(/, [])).toEqual([
      "lib/payments/toss-gateway.ts",
      "lib/payments/toss.ts",
    ]);
  });

  test("only the Absurd handler executes a refund", () => {
    expect(offenders(/\bcancelOrder\s*\(/, [])).toEqual([
      "lib/payments/payment-jobs.ts",
      "lib/payments/toss-gateway.ts",
    ]);
    expect(offenders(/\bcancelPayment\s*\(/, [])).toEqual([
      "lib/payments/toss-gateway.ts",
      "lib/payments/toss.ts",
    ]);
    expect(
      offenders(
        /export\s+(?:async\s+)?function\s+(?:resumeRefund|finishRefund)\b/,
        [],
      ),
    ).toEqual([]);
  });

  test("production never drains payment batches", () => {
    expect(
      offenders(/\brunDueJobs\s*\(/, ["lib/payments/payment-jobs.ts"]),
    ).toEqual([]);
    expect(offenders(/run-payment-jobs|payment-job-queue/, [])).toEqual([]);
  });

  test("application code never hard deletes users", () => {
    expect(
      offenders(
        /deleteFrom\(\s*["']users["']\s*\)|delete\s+from\s+users\b/i,
        [],
      ),
    ).toEqual([]);
  });

  test("the checks see the code they guard", () => {
    // A wrong path or pattern would make the tests above pass vacuously.
    expect(
      offenders(/billing_key_id\s*:[^\n]*\bnull\b/, []).length,
    ).toBeGreaterThan(0);
    expect(offenders(/insertInto\(\s*["']billing_keys["']\s*\)/, [])).toEqual([
      "lib/payments/billing-keys.ts",
    ]);
    expect(offenders(STORES_KEY, [])).toEqual([
      "lib/payments/billing-keys.ts",
      "lib/payments/subscription-signup.ts",
    ]);
    expect(
      offenders(/supporter_until\s*:(?!\s*(Date|string)\b)/, []).sort(),
    ).toEqual(["lib/payments/paid-time.ts"]);
    expect(offenders(/deleteFrom\(\s*["']users["']\s*\)/, [])).toEqual([]);
  });
});

// db.d.ts is a declaration file, so an override importing a module that does
// not exist type-checks quietly as `any`: the payment statuses lost their
// types that way when the payment code moved. Every import must resolve.
describe("database type overrides", () => {
  test("import modules that exist", () => {
    const config = readFileSync(
      join(SRC, "..", ".kysely-codegenrc.json"),
      "utf8",
    );
    const imports = [...config.matchAll(/import\(\\"([^\\]+)\\"\)/g)].map(
      (match) => match[1],
    );
    expect(imports.length).toBeGreaterThan(0);
    const missing = imports.filter(
      (path) =>
        ![".ts", ".tsx", ".d.ts"].some((ext) => {
          try {
            return statSync(join(SRC, "lib", path + ext)).isFile();
          } catch {
            return false;
          }
        }),
    );
    expect(missing).toEqual([]);
  });
});
