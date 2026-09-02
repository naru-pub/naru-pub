// Turns the hand-written SDK declarations into the compact JSON that
// /docs/sdk/[version] renders. Run `pnpm sdk-reference` after editing a .d.ts.
//
// TypeDoc parses the declarations and their TSDoc; everything below narrows its
// model down to what the page actually draws, so the committed artifact stays
// small, reviewable, and free of TypeDoc's internal ids.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { Application } from "typedoc";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSIONS = ["1.0.0"];

/* ---------------------------------------------------------------- types --- */

// Parenthesise only where TypeScript's own precedence would otherwise change
// meaning: `&` binds tighter than `|`, and both bind looser than `[]`.
const PRECEDENCE = { union: 1, intersection: 2 };
const UNION_MEMBER = 2;
const INTERSECTION_MEMBER = 3;
const ELEMENT = 4;

function atom(type, floor) {
  const text = renderType(type);
  const precedence = PRECEDENCE[type?.type] ?? ELEMENT;
  // A bare function type swallows whatever follows it, so it needs parentheses
  // anywhere it is not already the whole type.
  const swallows = type?.type === "reflection" && text.startsWith("(");
  return precedence < floor || swallows ? `(${text})` : text;
}

function renderType(type) {
  if (!type) return "unknown";
  switch (type.type) {
    case "intrinsic":
      return type.name;
    case "literal":
      return typeof type.value === "string"
        ? JSON.stringify(type.value)
        : String(type.value);
    case "reference": {
      const args = type.typeArguments?.length
        ? `<${type.typeArguments.map(renderType).join(", ")}>`
        : "";
      return `${type.name}${args}`;
    }
    case "array":
      return `${atom(type.elementType, ELEMENT)}[]`;
    case "union":
      return type.types
        .map((inner) => atom(inner, UNION_MEMBER))
        .join(" | ");
    case "intersection":
      return type.types
        .map((inner) => atom(inner, INTERSECTION_MEMBER))
        .join(" & ");
    case "typeOperator":
      return `${type.operator} ${atom(type.target, INTERSECTION_MEMBER)}`;
    case "templateLiteral": {
      const tail = type.tail
        .map(([inner, literal]) => `\${${renderType(inner)}}${literal}`)
        .join("");
      return `\`${type.head}${tail}\``;
    }
    case "reflection":
      return renderReflection(type.declaration);
    default:
      return type.name ?? "unknown";
  }
}

function renderReflection(declaration) {
  if (!declaration) return "object";
  const signature = declaration.signatures?.[0];
  if (signature)
    return `(${renderParameters(signature)}) => ${renderType(signature.type)}`;
  const properties = [
    // An index signature carries the shape of open-ended records such as Json.
    ...(declaration.indexSignatures ?? []).map(
      (index) =>
        `[${index.parameters[0].name}: ${renderType(index.parameters[0].type)}]:` +
        ` ${renderType(index.type)}`,
    ),
    ...(declaration.children ?? []).map((child) => {
      // A method inside an inline object type carries signatures, not a type.
      const signature = child.signatures?.[0];
      if (signature)
        return (
          `${child.name}${renderTypeParameters(signature)}` +
          `(${renderParameters(signature)}): ${renderType(signature.type)}`
        );
      return `${child.name}${child.flags?.isOptional ? "?" : ""}: ${renderType(child.type)}`;
    }),
  ];
  return properties.length ? `{ ${properties.join("; ")} }` : "{}";
}

const renderParameters = (signature) =>
  (signature.parameters ?? [])
    .map(
      (parameter) =>
        `${parameter.flags?.isRest ? "..." : ""}${parameter.name}` +
        `${parameter.flags?.isOptional ? "?" : ""}: ${renderType(parameter.type)}`,
    )
    .join(", ");

const renderTypeParameters = (holder) =>
  holder.typeParameters?.length
    ? `<${holder.typeParameters
        .map(
          (parameter) =>
            parameter.name +
            (parameter.default ? ` = ${renderType(parameter.default)}` : ""),
        )
        .join(", ")}>`
    : "";

/* ------------------------------------------------------------- comments --- */

// TypeDoc hands back a flat run of parts; regroup it into paragraphs, inline
// code spans and fenced examples so the page can style each on its own terms.
function renderComment(comment) {
  if (!comment?.summary?.length) return [];
  const blocks = [];
  let spans = [];
  const flush = () => {
    const text = spans.map((span) => span.value).join("").trim();
    if (text) blocks.push({ type: "paragraph", spans: trim(spans) });
    spans = [];
  };
  for (const part of comment.summary) {
    if (part.kind === "code" && part.text.startsWith("```")) {
      flush();
      blocks.push(fence(part.text));
      continue;
    }
    if (part.kind === "code") {
      spans.push({ type: "code", value: part.text.replace(/^`|`$/g, "") });
      continue;
    }
    // {@link Foo.bar} points at another export on the same page.
    if (part.kind === "inline-tag") {
      spans.push({
        type: "link",
        value: part.text,
        target: part.text.split(".")[0],
      });
      continue;
    }
    const text = part.text ?? "";
    for (const [index, chunk] of text.split(/\n{2,}/).entries()) {
      if (index) flush();
      if (chunk) spans.push({ type: "text", value: chunk.replace(/\n/g, " ") });
    }
  }
  flush();
  return blocks;
}

// The page highlights only what Code.tsx registers, so aliases collapse here
// rather than reaching the renderer as an unknown language.
const LANGUAGES = {
  js: "javascript",
  javascript: "javascript",
  ts: "javascript",
  json: "json",
  html: "html",
  xml: "html",
};

function fence(text) {
  const [first, ...rest] = text.replace(/```\s*$/, "").split("\n");
  const declared = first.replace(/^```/, "").trim().toLowerCase();
  return {
    type: "code",
    language: LANGUAGES[declared] ?? "javascript",
    code: rest.join("\n").replace(/\s+$/, ""),
  };
}

// Leading/trailing whitespace matters inside a span run but not at its edges.
function trim(spans) {
  const copy = spans.map((span) => ({ ...span }));
  if (copy.length) {
    copy[0].value = copy[0].value.replace(/^\s+/, "");
    copy.at(-1).value = copy.at(-1).value.replace(/\s+$/, "");
  }
  return copy.filter((span) => span.value !== "");
}

const tags = (comment, tag) =>
  (comment?.blockTags ?? [])
    .filter((block) => block.tag === tag)
    .map((block) => renderComment({ summary: block.content }));

const docs = (reflection) => {
  const comment = reflection.comment ?? reflection.signatures?.[0]?.comment;
  return {
    // Fenced blocks written inline keep their place in the prose; an @example
    // tag has nowhere else to go, so it lands at the end rather than vanishing.
    summary: [...renderComment(comment), ...tags(comment, "@example").flat()],
    throws: tags(comment, "@throws"),
  };
};

/* ------------------------------------------------------------ printing --- */

// Long signatures are the page's main content, so they are wrapped by Prettier
// rather than left to scroll sideways off the column.
const PRETTIER = { parser: "typescript", printWidth: 76 };
const pretty = async (code) => (await format(code, PRETTIER)).trim();

/** Formats a member as if it stood inside an interface, then unwraps it. */
async function printMember(signature) {
  const formatted = await pretty(`interface _ {\n${signature};\n}`);
  return formatted
    .split("\n")
    .slice(1, -1)
    .map((line) => line.replace(/^ {2}/, ""))
    .join("\n")
    .replace(/;$/, "");
}

async function printEntry(kind, signature) {
  if (kind === "function")
    return (await pretty(`declare function ${signature};`))
      .replace(/^declare function /, "")
      .replace(/;$/, "");
  if (kind === "type") return (await pretty(`${signature};`)).replace(/;$/, "");
  if (kind === "variable")
    return (await pretty(`declare ${signature};`))
      .replace(/^declare /, "")
      .replace(/;$/, "");
  // Interface and class headers carry no member list here, so they stay short.
  return signature;
}

/* --------------------------------------------------------------- shape ---- */

const KINDS = {
  32: "variable",
  64: "function",
  128: "class",
  256: "interface",
  2097152: "type",
};

async function member(child) {
  const signature = child.signatures?.[0];
  const text = signature
    ? `${child.name}${renderTypeParameters(signature)}(${renderParameters(signature)}): ${renderType(signature.type)}`
    : `${child.name}${child.flags?.isOptional ? "?" : ""}: ${renderType(child.type)}`;
  return {
    name: child.name,
    optional: Boolean(child.flags?.isOptional),
    signature: await printMember(text),
    ...docs(child),
  };
}

async function entry(child) {
  const kind = KINDS[child.kind];
  const base = { name: child.name, kind, ...docs(child) };
  if (kind === "type")
    return {
      ...base,
      signature: await printEntry(
        kind,
        `type ${child.name}${renderTypeParameters(child)} = ${renderType(child.type)}`,
      ),
    };
  if (kind === "variable")
    return {
      ...base,
      signature: await printEntry(
        kind,
        `const ${child.name}: ${renderType(child.type)}`,
      ),
    };
  if (kind === "function") {
    const signature = child.signatures[0];
    return {
      ...base,
      signature: await printEntry(
        kind,
        `${child.name}(${renderParameters(signature)}): ${renderType(signature.type)}`,
      ),
      parameters: (signature.parameters ?? []).map((parameter) => ({
        name: parameter.name,
        type: renderType(parameter.type),
        ...docs(parameter),
      })),
    };
  }
  // Inherited members are filtered out below, so the extends clause is the only
  // thing telling the reader where the rest of the shape comes from.
  const extended = child.extendedTypes?.length
    ? ` extends ${child.extendedTypes.map(renderType).join(", ")}`
    : "";
  return {
    ...base,
    signature: `${kind} ${child.name}${renderTypeParameters(child)}${extended}`,
    extends: child.extendedTypes?.map(renderType) ?? [],
    // Inherited Error plumbing is noise on a reference page.
    members: await Promise.all(
      (child.children ?? [])
        .filter((grandchild) => !grandchild.flags?.isInherited)
        .filter((grandchild) => grandchild.kind !== 512)
        .map(member),
    ),
  };
}

/* ----------------------------------------------------------------- run ---- */

async function build(version) {
  const entryPoint = join(root, "public", "sdk", version, "naru-data.d.ts");
  // The declarations are standalone by design, so they are read on their own
  // terms rather than through the application's tsconfig.
  const app = await Application.bootstrap({
    entryPoints: [entryPoint],
    tsconfig: join(root, "scripts", "tsconfig.sdk-reference.json"),
    excludeExternals: true,
    excludePrivate: true,
    skipErrorChecking: false,
    logLevel: "Warn",
  });
  const project = await app.convert();
  if (!project) throw new Error(`TypeDoc could not read ${entryPoint}`);
  if (app.logger.hasErrors() || app.logger.hasWarnings())
    throw new Error(`TypeDoc reported problems in ${entryPoint}`);
  const model = await app.serializer.projectToObject(project, root);

  const entries = await Promise.all(
    (model.children ?? []).filter((child) => KINDS[child.kind]).map(entry),
  );
  const order = ["function", "interface", "class", "type", "variable"];
  entries.sort(
    (a, b) =>
      order.indexOf(a.kind) - order.indexOf(b.kind) ||
      a.name.localeCompare(b.name),
  );

  const output = join(root, "src", "lib", "sdk-reference", `${version}.json`);
  // No timestamp: regenerating unchanged declarations must produce no diff.
  const contents = `${JSON.stringify({ version, entries }, null, 2)}\n`;

  if (check) {
    // Compared here rather than with `git diff`, which ignores a file that has
    // not been committed yet and would let a stale check pass.
    const existing = await readFile(output, "utf8").catch(() => null);
    if (existing !== contents)
      throw new Error(
        `${output} is out of date. Run \`pnpm sdk-reference\` and commit the result.`,
      );
    return { version, count: entries.length, checked: true };
  }

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
  return { version, count: entries.length, checked: false };
}

const check = process.argv.includes("--check");
for (const version of VERSIONS) {
  const result = await build(version);
  console.log(
    `sdk-reference ${result.version}: ${result.count} exports` +
      (result.checked ? " (up to date)" : ""),
  );
}
