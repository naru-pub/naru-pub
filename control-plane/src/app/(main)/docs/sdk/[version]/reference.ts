import reference100 from "@/lib/sdk-reference/1.0.0.json";

/** Every published SDK version that has a generated reference. Add a version
 * here and to scripts/generate-sdk-reference.mjs when one ships. */
export const REFERENCES = { "1.0.0": reference100 } as const;

export type Version = keyof typeof REFERENCES;

export const isVersion = (value: string): value is Version =>
  Object.hasOwn(REFERENCES, value);

/** The shapes scripts/generate-sdk-reference.mjs writes. */
export type Span =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "link"; value: string; target: string };

export type Block =
  | { type: "paragraph"; spans: Span[] }
  | { type: "code"; language: string; code: string };

export interface Member {
  name: string;
  optional: boolean;
  signature: string;
  summary: Block[];
  throws: Block[][];
}

export interface Entry {
  name: string;
  kind: "function" | "interface" | "class" | "type" | "variable";
  signature: string;
  summary: Block[];
  throws: Block[][];
  extends?: string[];
  members?: Member[];
  parameters?: { name: string; type: string; summary: Block[] }[];
}
