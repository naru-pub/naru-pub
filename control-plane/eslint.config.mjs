import coreWebVitals from "eslint-config-next/core-web-vitals";

// Next 16 removed `next lint`, so ESLint runs directly and needs flat config.
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "public/sdk/**",
      "public/examples/**",
      "src/lib/db.d.ts",
    ],
  },
  ...coreWebVitals,
];

export default config;
