import { db } from "@/lib/database";
import { addPaymentGrace } from "@/lib/subscriptions";

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
// the operator listing both spell out which 후원자 전용 기능 an account touched.
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

const PREVIEW_FEATURES: Feature[] = ["custom_domains", "analytics", "database"];

// null means the rollout gate is inactive and supporter entitlements apply.
export function previewFeatureAccess(
  supporterComp: boolean,
  feature: Feature,
): boolean | null {
  if (
    process.env.FEATURE_ACCESS_MODE === "supporters" ||
    !PREVIEW_FEATURES.includes(feature)
  )
    return null;
  return supporterComp;
}

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
  userId: number,
): Promise<UserEntitlement> {
  const row = await db
    .selectFrom("users")
    .leftJoin("subscriptions", "subscriptions.user_id", "users.id")
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
export async function getUserFeatures(userId: number): Promise<Set<Feature>> {
  const [user, ent] = await Promise.all([
    process.env.FEATURE_ACCESS_MODE !== "supporters"
      ? db
          .selectFrom("users")
          .select("supporter_comp")
          .where("id", "=", userId)
          .executeTakeFirst()
      : undefined,
    getUserEntitlement(userId),
  ]);

  const planFeatures = ent.isSupporter
    ? (PLAN_FEATURES[ent.plan ?? "supporter"] ?? [])
    : [];

  const features = new Set<Feature>();
  for (const feature of ALL_FEATURES) {
    const preview = user
      ? previewFeatureAccess(!!user.supporter_comp, feature)
      : null;
    if (preview !== null) {
      if (preview) features.add(feature);
      continue;
    }
    if (planFeatures.includes(feature)) features.add(feature);
  }
  return features;
}

export async function userHasFeature(
  userId: number,
  feature: Feature,
): Promise<boolean> {
  if (process.env.FEATURE_ACCESS_MODE !== "supporters") {
    const user = await db
      .selectFrom("users")
      .select("supporter_comp")
      .where("id", "=", userId)
      .executeTakeFirst();
    if (user) {
      const preview = previewFeatureAccess(!!user.supporter_comp, feature);
      if (preview !== null) return preview;
    }
  }
  const ent = await getUserEntitlement(userId);
  if (!ent.isSupporter) return false;
  const planFeatures = PLAN_FEATURES[ent.plan ?? "supporter"] ?? [];
  return planFeatures.includes(feature);
}
