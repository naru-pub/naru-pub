import type { UploadProgress } from "@/lib/upload-progress";

export default function UploadStatus({
  progress,
}: {
  progress: UploadProgress;
}) {
  const percent = Math.floor((progress.completed / progress.total) * 100);
  const label =
    progress.phase === "preparing"
      ? "파일 전송 및 준비 중…"
      : progress.phase === "finalizing"
        ? "파일 목록 갱신 중…"
        : "파일 저장 중…";
  return (
    <div className="w-64 max-w-full space-y-2" aria-live="polite" role="status">
      <p className="font-semibold">{label}</p>
      <progress
        className="w-full h-2 accent-primary"
        aria-label="저장 완료한 파일 수"
        max={progress.total}
        value={progress.phase === "preparing" ? undefined : progress.completed}
      />
      <p className="text-sm tabular-nums">
        {progress.completed} / {progress.total}개 완료 · {percent}%
      </p>
      {progress.fileName && (
        <p className="text-xs text-muted-foreground break-all">
          {progress.fileName}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        완료될 때까지 이 페이지를 열어 두세요.
      </p>
    </div>
  );
}
