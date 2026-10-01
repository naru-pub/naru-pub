const nextJest = require("next/jest");

module.exports = async () => {
  const config = await nextJest({ dir: "./" })({
    testEnvironment: "node",
    testMatch: ["<rootDir>/src/lib/payments/__tests__/*.test.ts"],
    moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1" },
  })();
  config.transformIgnorePatterns = [
    "node_modules/(?!(?:\\.pnpm/kysely@[^/]+/node_modules/)?kysely/)",
  ];
  return config;
};
