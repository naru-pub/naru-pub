"use client";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "sonner";
import { loadingFetch } from "@/lib/loading-bar";

export default function DeleteButton({ filename }: { filename: string }) {
  const confirm = useConfirm();

  return (
    <Button
      variant="destructive"
      onClick={async () => {
        if (
          !(await confirm({
            title: "정말로 삭제하시겠습니까?",
            confirmText: "삭제",
            destructive: true,
          }))
        ) {
          return;
        }

        try {
          const response = await loadingFetch("/api/files/delete", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ filename }),
          });

          const res = await response.json();
          if (res.success) {
            toast.success(`${res.message}: ${filename}`);
            // Refresh the page to update the file list
            window.location.reload();
          } else {
            toast.error(`${res.message}: ${filename}`);
          }
        } catch (error) {
          toast.error(`파일 삭제에 실패했습니다: ${filename}`);
        }
      }}
    >
      삭제
    </Button>
  );
}
