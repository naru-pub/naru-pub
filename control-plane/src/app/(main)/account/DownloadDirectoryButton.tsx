"use client";

import { Button } from "@/components/ui/button";
import { Download, Loader, Package } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";

interface ExportStatus {
  status: string;
  sizeBytes: number | null;
  errorMessage: string | null;
  createdAt: string | null;
  completedAt: string | null;
  downloadUrl: string | null;
}

export default function DownloadDirectoryButton({
  hasVerifiedEmail,
}: {
  hasVerifiedEmail: boolean;
}) {
  const [exportStatus, setExportStatus] = useState<ExportStatus | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isPolling, setIsPolling] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/account/export/status");
      const data = await res.json();
      setExportStatus(data.export);
      return data.export as ExportStatus | null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll while pending or in_progress. Depending on the status alone keeps
  // each refetch from restarting the interval it is being polled by.
  const status = exportStatus?.status;
  useEffect(() => {
    if (status !== "pending" && status !== "in_progress") {
      setIsPolling(false);
      return;
    }

    setIsPolling(true);
    const interval = setInterval(async () => {
      const latest = await fetchStatus();
      if (
        latest &&
        latest.status !== "pending" &&
        latest.status !== "in_progress"
      ) {
        setIsPolling(false);
        if (latest.status === "completed") {
          toast.success("갠홈 내보내기가 완료되었습니다.");
        } else if (latest.status === "failed") {
          toast.error("갠홈 내보내기에 실패했습니다.");
        }
      }
    }, 10_000);

    return () => clearInterval(interval);
  }, [status, fetchStatus]);

  const handleRequest = async () => {
    setIsRequesting(true);
    try {
      const res = await fetch("/api/account/export/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error);
        return;
      }

      toast.success(data.message);
      await fetchStatus();
    } catch {
      toast.error("내보내기 요청 중 오류가 발생했습니다.");
    } finally {
      setIsRequesting(false);
    }
  };

  if (!hasVerifiedEmail) {
    return (
      <Button disabled className="flex items-center gap-2">
        <Download size={16} />
        갠홈 내보내기 (이메일 인증 필요)
      </Button>
    );
  }

  const isPending =
    exportStatus?.status === "pending" ||
    exportStatus?.status === "in_progress";

  if (isPending || isPolling) {
    return (
      <Button disabled className="flex items-center gap-2">
        <Loader size={16} className="animate-spin" />
        내보내기 진행 중...
      </Button>
    );
  }

  if (exportStatus?.status === "completed" && exportStatus.downloadUrl) {
    return (
      <div className="flex items-center gap-2">
        <a href={exportStatus.downloadUrl}>
          <Button className="flex items-center gap-2">
            <Package size={16} />
            다운로드
          </Button>
        </a>
        <Button
          variant="outline"
          onClick={handleRequest}
          disabled={isRequesting}
          className="flex items-center gap-2"
        >
          <Download size={16} />
          새로 내보내기
        </Button>
      </div>
    );
  }

  return (
    <Button
      onClick={handleRequest}
      disabled={isRequesting}
      className="flex items-center gap-2"
    >
      <Download size={16} />
      {isRequesting ? "요청 중..." : "갠홈 내보내기"}
    </Button>
  );
}
