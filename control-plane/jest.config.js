const nextJest = require("next/jest");

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files
  dir: "./",
});

// Add any custom config to be passed to Jest
const customJestConfig = {
  // Add more setup options before each test is run
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],

  // Test environment
  testEnvironment: "jest-environment-jsdom",

  // Test file patterns
  testMatch: ["**/__tests__/**/*.(ts|tsx|js)", "**/*.(test|spec).(ts|tsx|js)"],

  // Coverage settings
  collectCoverageFrom: [
    "src/**/*.{ts,tsx}",
    "!src/**/*.d.ts",
    "!src/**/*.stories.{ts,tsx}",
    "!src/**/*.test.{ts,tsx}",
    "!src/**/__tests__/**",
  ],

  // Extensions to resolve
  moduleFileExtensions: ["ts", "tsx", "js", "jsx"],

  // Ignore patterns. tests/ holds node:test suites run by `pnpm test:node`,
  // and the site database suites need real PostgreSQL under
  // jest.data.config.cjs, so neither belongs in this jsdom run.
  testPathIgnorePatterns: [
    "<rootDir>/.next/",
    "<rootDir>/node_modules/",
    "<rootDir>/tests/",
    "<rootDir>/src/lib/site-data/",
  ],

  // Mock static assets and modules
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "\\.(css|less|scss|sass)$": "identity-obj-proxy",
  },
};

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
module.exports = async () => {
  const config = await createJestConfig(customJestConfig)();
  // next/jest replaces transformIgnorePatterns wholesale, so this has to be
  // applied afterwards. Kysely 0.29 is ESM-only and needs SWC under pnpm.
  config.transformIgnorePatterns = [
    "node_modules/(?!(?:\\.pnpm/kysely@[^/]+/node_modules/)?kysely/)",
  ];
  return config;
};
