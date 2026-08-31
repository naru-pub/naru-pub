"use client";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { uploadFiles, type UploadProgress } from "@/lib/upload-progress";

export function useFileUpload(refresh: () => Promise<void>) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const inFlight = useRef(false);
  async function upload(files: File[], directory: string) {
    if (inFlight.current || !files.length) return false;
    inFlight.current = true;
    setUploading(true);
    try {
      await uploadFiles(files, directory, setProgress);
      toast.success(`${files.length}개 파일을 업로드했습니다.`);
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "파일 업로드에 실패했습니다.",
      );
      return false;
    } finally {
      try {
        await refresh();
      } finally {
        setUploading(false);
        setProgress(null);
        inFlight.current = false;
      }
    }
  }
  return { uploading, progress, upload };
}
