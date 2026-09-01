const nextJest = require("next/jest");

module.exports = async () => {
  const config = await nextJest({ dir: "./" })({
    testEnvironment: "node",
    testMatch: ["<rootDir>/src/lib/__tests__/toss.test.ts"],
    moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1" },
  })();
  return config;
};
