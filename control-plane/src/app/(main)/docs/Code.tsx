import { highlight, LANGUAGE_LABELS, type Language } from "./highlight";
import styles from "./Code.module.css";

// Server component: only the highlighted markup and CSS reach the browser.
export default function Code({
  children,
  language = "javascript",
}: {
  children: string;
  language?: Language;
}) {
  const highlighted = highlight(children, language);
  return (
    <figure
      className={`${styles.block} min-w-0 overflow-hidden rounded-lg border`}
    >
      <figcaption className="border-b px-4 py-2 text-xs text-muted-foreground">
        {LANGUAGE_LABELS[language]}
      </figcaption>
      <pre
        className="overflow-x-auto p-4 text-sm leading-7 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        tabIndex={0}
        aria-label={`${LANGUAGE_LABELS[language]} 코드 예제`}
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
