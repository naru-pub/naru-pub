"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { boardRequest } from "../_components/api";

export function MarkAllReadButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await boardRequest("/api/board/notifications/read", "POST");
          router.refresh();
        } catch (error: any) {
          toast.error(error.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      모두 읽음으로 표시
    </Button>
  );
}
