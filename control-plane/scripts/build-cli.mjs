// Compiles src/cli and src/migrations to dist/ for the jobs image, which runs
// them with plain node instead of tsx: tsx transpiles every module on every
// start, which costs each maintenance job and the long-running worker
// processes about 60MB and 0.2s. Locally, `pnpm <script>` still uses tsx.
//
// Each CLI is one bundle of our own code. Runtime dependencies stay imports,
// resolved from the image's production node_modules; anything else a CLI
// imports is a devDependency and is bundled in, because the image does not
// install those.
//
// dist/package.json lists only the dependencies the output imports, and the
// jobs image installs from it, so the web app's (Next, React, Monaco and the
// rest) stay out. A CLI that reaches Next or React through shared code fails
// the build instead: those need a request, and would bring the web app's
// dependencies back.
//
// Output is ESM (.mjs) because several dependencies are ESM-only. The banner
// gives it what CommonJS code expects: require for the bundled CommonJS
// packages, and __dirname, through which migrate.ts finds the migrations,
// compiled beside it at the same relative path.
import { build } from "esbuild";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
process.chdir(root);

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const { dependencies } = manifest;
const external = Object.keys(dependencies).flatMap((name) => [
  name,
  `${name}/*`,
]);

const sources = async (directory, pattern) =>
  (await readdir(directory))
    .filter((file) => pattern.test(file))
    .map((file) => `${directory}/${file}`);

const common = {
  platform: "node",
  format: "esm",
  target: "node24",
  outExtension: { ".js": ".mjs" },
  tsconfig: "tsconfig.json",
  logLevel: "warning",
  banner: {
    js: [
      'import { fileURLToPath as __naruFileURLToPath } from "node:url";',
      'import { dirname as __naruDirname } from "node:path";',
      'import { createRequire as __naruCreateRequire } from "node:module";',
      "const require = __naruCreateRequire(import.meta.url);",
      "const __filename = __naruFileURLToPath(import.meta.url);",
      "const __dirname = __naruDirname(__filename);",
    ].join("\n"),
  },
};

await rm("dist", { recursive: true, force: true });

const results = [
  await build({
    ...common,
    // env.ts is imported by the others, not run on its own.
    entryPoints: await sources("src/cli", /^(?!env\.)[^.]+\.tsx?$/),
    outdir: "dist/cli",
    bundle: true,
    external,
    sourcemap: true,
    metafile: true,
  }),
  await build({
    ...common,
    entryPoints: await sources("src/migrations", /\.ts$/),
    outdir: "dist/migrations",
    bundle: true,
    external,
    metafile: true,
  }),
];

// "@scope/name/sub" and "name/sub" to the package that provides them.
const packageOf = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

const used = new Map();
for (const { metafile } of results) {
  for (const [file, { imports }] of Object.entries(metafile.inputs)) {
    for (const { path, external: isExternal } of imports) {
      const name = packageOf(path);
      if (isExternal && name in dependencies) {
        used.set(name, [...(used.get(name) ?? []), file]);
      }
    }
  }
}

const forbidden = ["next", "react", "react-dom"].filter((name) =>
  used.has(name),
);
if (forbidden.length > 0) {
  for (const name of forbidden) {
    console.error(
      `${name} is imported by ${[...new Set(used.get(name))].join(", ")}`,
    );
  }
  console.error(
    "The CLIs must not import Next or React; move what they need out of those modules.",
  );
  process.exit(1);
}

await writeFile(
  "dist/package.json",
  JSON.stringify(
    {
      name: manifest.name,
      private: true,
      dependencies: Object.fromEntries(
        [...used.keys()].sort().map((name) => [name, dependencies[name]]),
      ),
    },
    null,
    2,
  ) + "\n",
);
