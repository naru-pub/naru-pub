import coreWebVitals from "eslint-config-next/core-web-vitals";

// `next lint` had been broken since Next 16 removed the command, so these
// React Compiler rules had never actually run against the existing pages.
// They stay warnings until login, support and verify-email are reworked, so
// the gate catches new violations instead of failing on old ones.
const PRE_EXISTING = [
  "react-hooks/immutability",
  "react-hooks/purity",
  "react-hooks/set-state-in-effect",
];

// Next 16 removed `next lint`, so ESLint runs directly and needs flat config.
export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "public/sdk/**",
      "public/examples/**",
      "src/lib/db.d.ts",
    ],
  },
  // Severity is relaxed in place: a separate config object cannot reference
  // the react-hooks plugin, which only this one declares.
  ...coreWebVitals.map((config) =>
    PRE_EXISTING.some((rule) => config.rules?.[rule])
      ? {
          ...config,
          rules: {
            ...config.rules,
            ...Object.fromEntries(PRE_EXISTING.map((rule) => [rule, "warn"])),
          },
        }
      : config,
  ),
];
