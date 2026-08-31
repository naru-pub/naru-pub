// Use real PostgreSQL and skip the legacy global auth/request mocks.
const nextJest = require("next/jest");
module.exports = async () => {
  const config = await nextJest({ dir: "./" })({
    testEnvironment: "node",
    testMatch: ["<rootDir>/src/lib/site-data/__tests__/**/*.test.ts"],
    moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1" },
  })();
  // Kysely 0.29 is ESM-only; allow SWC to transform it under pnpm as well.
  config.transformIgnorePatterns = [
    "node_modules/(?!(?:\\.pnpm/kysely@[^/]+/node_modules/)?kysely/)",
  ];
  return config;
};
