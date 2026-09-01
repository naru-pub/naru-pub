/** @jest-environment node */
import { afterEach, describe, expect, test } from "@jest/globals";
import { previewFeatureAccess } from "@/lib/entitlements";

const originalMode = process.env.FEATURE_ACCESS_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.FEATURE_ACCESS_MODE;
  else process.env.FEATURE_ACCESS_MODE = originalMode;
});

describe("limited feature rollout", () => {
  test("allows only supporter-comp users in preview mode", () => {
    process.env.FEATURE_ACCESS_MODE = "preview";
    expect(previewFeatureAccess(true, "database")).toBe(true);
    expect(previewFeatureAccess(true, "analytics")).toBe(true);
    expect(previewFeatureAccess(false, "custom_domains")).toBe(false);
    expect(previewFeatureAccess(false, "github_deploys")).toBeNull();
  });

  test("defers all features to entitlements in supporter mode", () => {
    process.env.FEATURE_ACCESS_MODE = "supporters";
    expect(previewFeatureAccess(false, "database")).toBeNull();
    expect(previewFeatureAccess(true, "analytics")).toBeNull();
  });
});
