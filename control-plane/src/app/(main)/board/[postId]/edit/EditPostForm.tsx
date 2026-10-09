"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MAX_POST_BODY_LENGTH, MAX_TITLE_LENGTH } from "@/lib/board/constants";
import { boardRequest } from "../../_components/api";

export function EditPostForm({
  postId,
  title: initialTitle,
  body: initialBody,
}: {
  postId: string;
  title: string;
  body: string;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await boardRequest(`/api/board/posts/${postId}`, "PATCH", {
        title,
        body,
      });
      toast.success("고쳤어요.");
      router.push(`/board/${postId}`);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="edit-title" className="text-sm font-bold">
          제목
        </label>
        <Input
          id="edit-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={MAX_TITLE_LENGTH}
          required
          className="h-12 md:text-base"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="edit-body" className="text-sm font-bold">
          본문
        </label>
        <Textarea
          id="edit-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={MAX_POST_BODY_LENGTH}
          rows={10}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={busy} className="text-sm">
          저장
        </Button>
      </div>
    </form>
  );
}
