export type UploadProgress = {
  completed: number;
  total: number;
  fileName: string;
  phase: "preparing" | "saving" | "finalizing";
};
export type UploadResult = { success: boolean; message: string };

// Opt-in response streaming keeps one batch request and one site-edit record.
export function streamUpload(
  files: File[],
  upload: (file: File) => Promise<UploadResult>,
  finalize: () => Promise<void>,
) {
  let cancelled = false;
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let completed = 0;
      let result: UploadResult = {
        success: true,
        message: "업로드되었습니다.",
      };
      const emit = (event: object) => {
        if (!cancelled) {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          } catch {
            cancelled = true;
          }
        }
      };
      try {
        for (const file of files) {
          if (cancelled) break;
          emit({
            type: "progress",
            completed,
            total: files.length,
            fileName: file.name,
            phase: "saving",
          });
          result = await upload(file);
          if (!result.success) {
            result.message = `${file.name}: ${result.message}`;
            break;
          }
          completed++;
          emit({
            type: "progress",
            completed,
            total: files.length,
            fileName: file.name,
            phase: "saving",
          });
        }
      } catch {
        result = {
          success: false,
          message:
            "업로드 연결에 문제가 발생했습니다. 다시 시도하기 전에 파일 목록을 확인하세요.",
        };
      }
      // Files already stored must appear even if a later file fails or the client disconnects.
      if (completed > 0) {
        try {
          emit({
            type: "progress",
            completed,
            total: files.length,
            fileName: "",
            phase: "finalizing",
          });
          await finalize();
        } catch {
          result = {
            success: false,
            message: "파일은 저장되었지만 목록 갱신에 실패했습니다.",
          };
        }
      }
      emit({ type: "done", ...result, completed, total: files.length });
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
}

export async function uploadFiles(
  files: File[],
  directory: string,
  onProgress: (progress: UploadProgress) => void,
): Promise<void> {
  if (!files.length) return;
  onProgress({
    completed: 0,
    total: files.length,
    fileName: "",
    phase: "preparing",
  });
  const body = new FormData();
  body.append(
    "directory",
    directory ? directory.replace(/\/+$/, "") + "/" : "",
  );
  files.forEach((file) => body.append("file", file));
  const response = await fetch("/api/files/upload", {
    method: "POST",
    body,
    headers: { Accept: "application/x-ndjson" },
  });
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("application/x-ndjson")
  ) {
    const result = await response.json();
    if (!response.ok || !result.success)
      throw new Error(result.message || "파일 업로드에 실패했습니다.");
    onProgress({
      completed: files.length,
      total: files.length,
      fileName: "",
      phase: "finalizing",
    });
    return;
  }
  if (!response.body) throw new Error("업로드 진행 상황을 확인할 수 없습니다.");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "progress") onProgress(event);
        else if (event.type === "done") {
          done = true;
          if (!event.success)
            throw new Error(
              `${event.message} (${event.completed}/${event.total})`,
            );
          onProgress({
            completed: event.completed,
            total: event.total,
            fileName: "",
            phase: "finalizing",
          });
        }
      }
      if (chunk.done && !done)
        throw new Error(
          "업로드 연결이 끊겼습니다. 다시 시도하기 전에 파일 목록을 확인하세요.",
        );
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
