"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MAX_REPLY_BODY_LENGTH } from "@/lib/board/constants";
import { boardRequest } from "./api";

export function ReplyComposer({
  postId,
  parentId,
  label,
  autoFocus = false,
  onDone,
}: {
  postId: string;
  parentId: string | null;
  label: string;
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  const router = useRouter();
  const id = useId();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      const { replyId } = await boardRequest<{ replyId: string }>(
        `/api/board/posts/${postId}/replies`,
        "POST",
        { parentId, body },
      );
      setBody("");
      onDone?.();
      router.refresh();
      // Let the refreshed tree render before jumping to the new reply.
      setTimeout(() => {
        document
          .getElementById(`reply-${replyId}`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 400);
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className={`flex flex-col border focus-within:ring-2 focus-within:ring-ring ${parentId ? "border-primary" : "border-border"}`}
    >
      <label
        htmlFor={id}
        className={`border-b border-border px-3 py-2 text-xs ${parentId ? "text-primary" : "text-muted-foreground"}`}
      >
        {label}
      </label>
      <Textarea
        id={id}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        maxLength={MAX_REPLY_BODY_LENGTH}
        autoFocus={autoFocus}
        rows={3}
        placeholder="답글을 남겨 주세요."
        className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
      />
      <div className="flex justify-end gap-2 border-t border-border p-2">
        {onDone && (
          <Button type="button" variant="outline" onClick={onDone}>
            취소
          </Button>
        )}
        <Button type="submit" disabled={busy || !body.trim()}>
          답글 달기
        </Button>
      </div>
    </form>
  );
}
