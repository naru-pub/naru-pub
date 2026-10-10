import coreWebVitals from "eslint-config-next/core-web-vitals";

// Next 16 removed `next lint`, so ESLint runs directly and needs flat config.
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "public/sdk/**",
      "src/lib/db.d.ts",
    ],
  },
  ...coreWebVitals,
  // The design system (/design): controls and dialogs come from
  // src/components/ui, so they share one look and one set of fixes.
  {
    files: ["src/app/**/*.tsx", "src/components/**/*.tsx"],
    ignores: ["src/components/ui/**"],
    rules: {
      "react/forbid-elements": [
        "error",
        {
          forbid: [
            { element: "button", message: "Use <Button> from @/components/ui/button." },
            { element: "select", message: "Use <Select> from @/components/ui/select." },
            { element: "textarea", message: "Use <Textarea> from @/components/ui/textarea." },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "confirm", message: "Use useConfirm() from @/components/ui/confirm." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "window", property: "confirm", message: "Use useConfirm() from @/components/ui/confirm." },
      ],
    },
  },
];

export default config;
