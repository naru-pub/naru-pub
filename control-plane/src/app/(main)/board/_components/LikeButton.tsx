"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { boardRequest } from "./api";

export function LikeButton({
  url,
  initialLiked,
  initialCount,
  signedIn,
  compact = false,
}: {
  url: string;
  initialLiked: boolean;
  initialCount: number;
  signedIn: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (!signedIn) {
      router.push("/login");
      return;
    }
    setBusy(true);
    try {
      const result = await boardRequest<{ likeCount: number }>(
        url,
        liked ? "DELETE" : "PUT",
      );
      setLiked(!liked);
      setCount(result.likeCount);
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant={compact ? "ghost" : "outline"}
      onClick={toggle}
      disabled={busy}
      aria-pressed={liked}
      className={
        compact
          ? `h-8 px-2 text-xs hover:text-foreground ${liked ? "font-bold text-primary" : "font-normal text-muted-foreground"}`
          : liked
            ? "border-primary text-primary hover:text-primary"
            : undefined
      }
    >
      반가워요 {count}
    </Button>
  );
}
