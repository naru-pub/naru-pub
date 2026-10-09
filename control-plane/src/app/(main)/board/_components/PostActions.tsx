"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { boardRequest } from "./api";

export function PostActions({
  postId,
  canEdit,
  canDelete,
  isTemplate,
}: {
  postId: string;
  canEdit: boolean;
  canDelete: boolean;
  isTemplate: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  async function remove() {
    const confirmed = await confirm(
      isTemplate
        ? {
            title: "이 글과 템플릿 파일을 지울까요?",
            description: "이미 적용한 사이트의 파일은 그대로 남아요.",
            confirmText: "지우기",
            destructive: true,
          }
        : { title: "이 글을 지울까요?", confirmText: "지우기", destructive: true },
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await boardRequest(`/api/board/posts/${postId}`, "DELETE");
      toast.success("글을 지웠어요.");
      router.push("/board");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
      setBusy(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success("링크를 복사했어요.");
    } catch {
      toast.error("링크를 복사하지 못했어요.");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" onClick={copyLink}>
        링크 복사
      </Button>
      {canEdit && (
        <Button asChild variant="outline">
          <Link href={`/board/${postId}/edit`}>고치기</Link>
        </Button>
      )}
      {canDelete && (
        <Button
          type="button"
          variant="outline"
          onClick={remove}
          disabled={busy}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          지우기
        </Button>
      )}
    </div>
  );
}
