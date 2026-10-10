import { Fragment } from "react";

// A collection name is one long token, such as
// does78teux_calendar_blog_categories, and break-all splits it at any letter.
// Offering a break after each _ and - wraps it between words instead; breaking
// anywhere is left for a name with no separator that still does not fit.
export default function CollectionName({ name }: { name: string }) {
  return (
    <span className="[overflow-wrap:anywhere]">
      {name.split(/(?<=[_-])/).map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </span>
  );
}
