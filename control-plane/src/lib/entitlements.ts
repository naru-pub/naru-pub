import type { Kysely } from "kysely";
import { db } from "@/lib/database";
import type { DB } from "@/lib/db";
import { addPaymentGrace, isCurrentPlan } from "@/lib/subscriptions";

/**
 * Callers already inside a transaction must pass their own `tx`. Reaching for
 * the pool from inside a held transaction takes a second connection while the
 * first is still checked out, and enough concurrent callers doing that empty
 * the pool with every one of them waiting on it.
 */
export type Executor = Kysely<DB>;

// Features that a paid (supporter) plan can unlock. Add new features here as
// they become gated.
export type Feature =
  | "custom_domains"
  | "github_deploys"
  | "analytics"
  | "database";

export const ALL_FEATURES: Feature[] = [
  "custom_domains",
  "github_deploys",
  "analytics",
  "database",
];

// Shown wherever a feature has to be named to a person — the refund screens and
// the operator listing both spell out which 유료 기능 an account touched.
export const FEATURE_LABELS: Record<Feature, string> = {
  custom_domains: "커스텀 도메인",
  github_deploys: "GitHub 배포",
  analytics: "방문자 현황",
  database: "데이터베이스",
};

export const PLAN_FEATURES: Record<string, Feature[]> = {
  supporter: ["custom_domains", "github_deploys", "analytics", "database"],
  // To add a richer tier later, add another plan key with its feature list.
};

export type UserEntitlement = {
  isSupporter: boolean;
  comp: boolean;
  /** Paid through a date still in the future, before any grace window. */
  paid: boolean;
  plan: string | null;
  supporterUntil: Date | null;
  graceEndsAt: Date | null;
  inPaymentGrace: boolean;
};

// Resolves a user's current entitlement. A user is a supporter if they have a
// permanent comp or a paid-through date that has not passed the grace window.
export async function getUserEntitlement(
  userId: string,
  executor: Executor = db,
): Promise<UserEntitlement> {
  const row = await executor
    .selectFrom("users")
    .leftJoin("subscriptions", (join) =>
      join.onRef("subscriptions.user_id", "=", "users.id").on(isCurrentPlan),
    )
    .select([
      "users.supporter_comp as comp",
      "users.supporter_until as supporterUntil",
      "subscriptions.plan as plan",
    ])
    .where("users.id", "=", userId)
    .executeTakeFirst();

  if (!row) {
    return {
      isSupporter: false,
      comp: false,
      paid: false,
      plan: null,
      supporterUntil: null,
      graceEndsAt: null,
      inPaymentGrace: false,
    };
  }

  const comp = !!row.comp;
  const supporterUntil = row.supporterUntil
    ? new Date(row.supporterUntil)
    : null;
  const graceEndsAt = supporterUntil ? addPaymentGrace(supporterUntil) : null;
  const paid = supporterUntil != null && supporterUntil.getTime() > Date.now();
  const inPaymentGrace =
    !paid && graceEndsAt != null && graceEndsAt.getTime() > Date.now();
  const isSupporter = comp || paid || inPaymentGrace;
  // Comp users have no subscription row, so default them to the supporter plan.
  const plan = row.plan ?? (comp ? "supporter" : null);

  return {
    isSupporter,
    comp,
    paid,
    plan,
    supporterUntil,
    graceEndsAt,
    inPaymentGrace,
  };
}

// Resolves every feature at once. The nav needs the whole set on every page
// load, and calling userHasFeature per feature would repeat the same
// entitlement lookup once for each of them.
export async function getUserFeatures(userId: string): Promise<Set<Feature>> {
  const ent = await getUserEntitlement(userId);
  if (!ent.isSupporter) return new Set();
  return new Set(PLAN_FEATURES[ent.plan ?? "supporter"] ?? []);
}

export async function userHasFeature(
  userId: string,
  feature: Feature,
  executor: Executor = db,
): Promise<boolean> {
  const ent = await getUserEntitlement(userId, executor);
  if (!ent.isSupporter) return false;
  const planFeatures = PLAN_FEATURES[ent.plan ?? "supporter"] ?? [];
  return planFeatures.includes(feature);
}
