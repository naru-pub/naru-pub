import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";

// One instance shared by every documentation page, so a language is registered
// once no matter how many blocks a page renders.
const highlighter = hljs.newInstance();
highlighter.registerLanguage("javascript", javascript);
highlighter.registerLanguage("json", json);
highlighter.registerLanguage("typescript", typescript);
highlighter.registerLanguage("xml", xml);

export const LANGUAGE_LABELS = {
  javascript: "JavaScript",
  json: "JSON",
  html: "HTML",
  typescript: "TypeScript",
} as const;

export type Language = keyof typeof LANGUAGE_LABELS;

/** Escapes the source and wraps its tokens in highlight.js spans. */
export const highlight = (code: string, language: Language) =>
  highlighter.highlight(code, {
    language: language === "html" ? "xml" : language,
  }).value;
