import Image from "next/image";
import Link from "next/link";

interface AdCardProps {
  title: string;
  imageSrc: string;
  imageAlt: string;
  description: string;
  href: string;
  // An empty slot, drawn with a dashed rule so it reads as an invitation.
  vacant?: boolean;
}

// One ally site in the front page's 동맹 사이트 row: a small picture, a name
// and a line, the whole card a link.
export function AdCard({
  title,
  imageSrc,
  imageAlt,
  description,
  href,
  vacant = false,
}: AdCardProps) {
  return (
    <Link
      href={href}
      target="_blank"
      className={`lift flex items-center gap-4 border-2 p-3.5 ${
        vacant ? "border-dashed border-muted-foreground" : "border-line bg-card"
      }`}
    >
      <Image
        src={imageSrc}
        alt={imageAlt}
        width={64}
        height={64}
        className="size-16 shrink-0 border border-border bg-white object-contain"
      />
      <span className="min-w-0 space-y-0.5">
        <span className="block font-bold text-foreground">{title}</span>
        <span className="block text-sm leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </Link>
  );
}
