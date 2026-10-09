import { Badge, type BadgeProps } from "@/components/ui/badge";
import { POST_KIND_LABELS, type PostKind } from "@/lib/board/constants";

// Templates get the sun highlight: they are what the board is for.
const KIND_VARIANTS: Record<PostKind, BadgeProps["variant"]> = {
  template: "sun",
  site: "link",
  question: "warning",
  chat: "outline",
};

export function KindBadge({ kind }: { kind: PostKind }) {
  return <Badge variant={KIND_VARIANTS[kind]}>{POST_KIND_LABELS[kind]}</Badge>;
}
