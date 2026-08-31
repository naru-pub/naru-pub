import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import styles from "./Code.module.css";

const highlighter = hljs.newInstance();
highlighter.registerLanguage("javascript", javascript);
highlighter.registerLanguage("json", json);
highlighter.registerLanguage("xml", xml);

const labels = { javascript: "JavaScript", json: "JSON", html: "HTML" };

// Server component: only the highlighted markup and CSS reach the browser.
export default function Code({
  children,
  language = "javascript",
}: {
  children: string;
  language?: keyof typeof labels;
}) {
  const highlighted = highlighter.highlight(children, {
    language: language === "html" ? "xml" : language,
  }).value;
  return (
    <figure
      className={`${styles.block} min-w-0 overflow-hidden rounded-lg border`}
    >
      <figcaption className="border-b px-4 py-2 text-xs text-muted-foreground">
        {labels[language]}
      </figcaption>
      <pre
        className="overflow-x-auto p-4 text-sm leading-7 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        tabIndex={0}
        aria-label={`${labels[language]} 코드 예제`}
      >
        {/* highlight.js escapes source text before adding its token spans. */}
        <code
          className={`language-${language}`}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </figure>
  );
}
