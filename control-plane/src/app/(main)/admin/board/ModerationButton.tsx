"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { boardRequest } from "../../board/_components/api";

// Deleting uses the same routes an author does; admins may delete anyone's.
// Restoring has its own admin-only routes.
export function ModerationButton({
  target,
  id,
  action,
}: {
  target: "post" | "reply";
  id: string;
  action: "delete" | "restore";
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const noun = target === "post" ? "글" : "답글";

  async function run() {
    if (
      action === "delete" &&
      !(await confirm({
        title: `이 ${noun}을 지울까요?`,
        confirmText: "삭제",
        destructive: true,
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      const base = target === "post" ? "posts" : "replies";
      if (action === "delete") {
        await boardRequest(`/api/board/${base}/${id}`, "DELETE");
      } else {
        await boardRequest(`/api/board/admin/${base}/${id}/restore`, "POST");
      }
      toast.success(action === "delete" ? "지웠어요." : "되살렸어요.");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={run}
      disabled={busy}
      className={
        action === "delete"
          ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
          : undefined
      }
    >
      {action === "delete" ? "지우기" : "되살리기"}
    </Button>
  );
}
