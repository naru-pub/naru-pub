"use client";

import { useState, useRef } from "react";
import { uploadFiles, type UploadProgress } from "@/lib/upload-progress";
import UploadStatus from "./UploadStatus";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export default function UploadButton({ directory }: { directory: string }) {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const inFlight = useRef(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (inFlight.current) return;
    setIsUploading(true);

    const formData = new FormData(e.currentTarget);
    const files = (formData.getAll("file") as File[]).filter(
      (file) => file.name,
    );

    if (files.length === 0) {
      toast.error("파일을 선택해주세요.");
      setIsUploading(false);
      return;
    }

    inFlight.current = true;
    try {
      await uploadFiles(files, directory, setProgress);
      toast.success(`${files.length}개 파일을 업로드했습니다.`);
      window.location.reload();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "파일 업로드에 실패했습니다.",
      );
    } finally {
      setIsUploading(false);
      setProgress(null);
      inFlight.current = false;
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap gap-2">
      <Input
        id="file"
        type="file"
        name="file"
        multiple
        disabled={isUploading}
      />
      <Button type="submit" disabled={isUploading}>
        {isUploading ? "업로드 중..." : "업로드"}
      </Button>
      {progress && (
        <div className="basis-full">
          <UploadStatus progress={progress} />
        </div>
      )}
    </form>
  );
}
