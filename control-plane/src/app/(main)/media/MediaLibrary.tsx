"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  FileArchive,
  FileAudio,
  FileText,
  ImageIcon,
  LoaderCircle,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type MediaFile = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  status: "ready";
  url: string;
  created_at: string;
  updated_at: string;
  metadata?: {
    altText?: string;
    references?: Array<{ collection?: string; id?: string; field?: string }>;
  };
};
type Usage = {
  bytes: number;
  count: number;
  pending: number;
  maxBytes: number;
  maxFiles: number;
};
type UploadState = {
  key: string;
  name: string;
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
};

async function api(path = "", method = "GET", body?: unknown) {
  const response = await fetch("/api/account/database/_files" + path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "요청에 실패했습니다.");
  return result;
}

function uploadToR2(
  url: string,
  method: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (value: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url);
    Object.entries(headers).forEach(([name, value]) =>
      request.setRequestHeader(name, value),
    );
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error("R2 업로드 실패 (HTTP " + request.status + ")"));
    };
    request.onerror = () => reject(new Error("R2 업로드 연결에 실패했습니다."));
    request.send(file);
  });
}

function formatBytes(value: number) {
  if (value < 1024) return value + " B";
  if (value < 1024 ** 2) return (value / 1024).toFixed(1) + " KiB";
  return (value / 1024 ** 2).toFixed(value >= 10 * 1024 ** 2 ? 0 : 1) + " MiB";
}

function TypeIcon({ type }: { type: string }) {
  if (type.startsWith("image/")) return <ImageIcon aria-hidden="true" />;
  if (type.startsWith("audio/")) return <FileAudio aria-hidden="true" />;
  if (type === "application/zip") return <FileArchive aria-hidden="true" />;
  return <FileText aria-hidden="true" />;
}

export default function MediaLibrary() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [usage, setUsage] = useState<Usage>({
    bytes: 0,
    count: 0,
    pending: 0,
    maxBytes: 250 * 1024 * 1024,
    maxFiles: 1000,
  });
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  async function refresh() {
    const result = await api();
    setFiles(result.files);
    setUsage(result.usage);
  }

  useEffect(() => {
    refresh()
      .catch((reason) => setError(reason.message))
      .finally(() => setBusy(false));
  }, []);

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const result = files.filter(
      (file) =>
        !normalized ||
        file.name.toLocaleLowerCase().includes(normalized) ||
        file.contentType.toLocaleLowerCase().includes(normalized),
    );
    result.sort((a, b) => {
      if (sort === "oldest")
        return Date.parse(a.created_at) - Date.parse(b.created_at);
      if (sort === "name") return a.name.localeCompare(b.name, "ko");
      if (sort === "largest") return b.size - a.size;
      return Date.parse(b.created_at) - Date.parse(a.created_at);
    });
    return result;
  }, [files, query, sort]);

  function updateUpload(key: string, changes: Partial<UploadState>) {
    setUploads((current) =>
      current.map((item) =>
        item.key === key ? { ...item, ...changes } : item,
      ),
    );
  }

  async function uploadFile(file: File) {
    const key = file.name + ":" + file.size + ":" + crypto.randomUUID();
    setUploads((current) => [
      ...current,
      { key, name: file.name, progress: 0, status: "uploading" },
    ]);
    let authorization:
      | {
          file: MediaFile;
          uploadUrl: string;
          method: string;
          headers: Record<string, string>;
        }
      | undefined;
    try {
      const created = (await api("", "POST", {
        name: file.name,
        contentType: file.type || "application/octet-stream",
        size: file.size,
      })) as NonNullable<typeof authorization>;
      authorization = created;
      await uploadToR2(
        created.uploadUrl,
        created.method,
        created.headers,
        file,
        (progress) => updateUpload(key, { progress }),
      );
      await api("/" + created.file.id, "PUT", {});
      updateUpload(key, { progress: 100, status: "done" });
      await refresh();
    } catch (reason) {
      if (authorization)
        void api("/" + authorization.file.id, "DELETE").catch(() => {});
      updateUpload(key, {
        status: "error",
        error:
          reason instanceof Error ? reason.message : "업로드에 실패했습니다.",
      });
    }
  }

  async function chooseFiles(list: FileList | null) {
    if (!list?.length) return;
    setError("");
    await Promise.all([...list].map(uploadFile));
    if (inputRef.current) inputRef.current.value = "";
  }

  async function copy(file: MediaFile) {
    try {
      await navigator.clipboard.writeText(file.url);
      setCopied(file.id);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      setError("URL을 클립보드에 복사하지 못했습니다.");
    }
  }

  async function remove(file: MediaFile) {
    const references = Array.isArray(file.metadata?.references)
      ? file.metadata.references
      : [];
    if (
      !window.confirm(
        "'" +
          file.name +
          `'을 영구 삭제할까요?${
            references.length
              ? ` ${references.length}개 문서 참조가 기록되어 있습니다.`
              : ""
          } 이 URL을 사용하는 글의 이미지나 다운로드가 깨질 수 있습니다.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api("/" + file.id, "DELETE");
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "삭제에 실패했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }

  const percent = Math.min(100, (usage.bytes / usage.maxBytes) * 100);
  return (
    <section className="space-y-6" aria-busy={busy}>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_320px]">
        <button
          type="button"
          className="group flex min-h-44 flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed bg-muted/20 p-6 text-center transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void chooseFiles(event.dataTransfer.files);
          }}
        >
          <span className="rounded-full bg-primary/10 p-3 text-primary">
            <Upload className="size-6" aria-hidden="true" />
          </span>
          <span className="font-semibold">파일을 끌어 놓거나 선택하세요</span>
          <span className="text-sm text-muted-foreground">
            이미지, 오디오, PDF, ZIP, 텍스트 · 파일당 최대 25 MiB
          </span>
        </button>
        <Card>
          <CardContent className="space-y-5 p-5">
            <div>
              <p className="text-sm text-muted-foreground">저장 공간</p>
              <p className="mt-1 text-xl font-semibold">
                {formatBytes(usage.bytes)}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  / {formatBytes(usage.maxBytes)}
                </span>
              </p>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: percent + "%" }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md bg-muted/50 p-3">
                <p className="text-muted-foreground">파일</p>
                <p className="font-semibold">
                  {usage.count} / {usage.maxFiles}
                </p>
              </div>
              <div className="rounded-md bg-muted/50 p-3">
                <p className="text-muted-foreground">처리 중</p>
                <p className="font-semibold">{usage.pending}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        multiple
        accept="image/avif,image/gif,image/jpeg,image/png,image/webp,audio/mpeg,audio/ogg,audio/opus,audio/wav,application/pdf,application/zip,text/plain"
        onChange={(event) => void chooseFiles(event.target.files)}
      />

      {!!uploads.length && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold">업로드</h3>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setUploads((items) =>
                  items.filter((item) => item.status === "uploading"),
                )
              }
            >
              완료 항목 지우기
            </Button>
          </div>
          {uploads.map((item) => (
            <div
              key={item.key}
              className="grid gap-2 text-sm sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
            >
              <div className="min-w-0">
                <p className="truncate">{item.name}</p>
                {item.error && (
                  <p className="text-xs text-destructive">{item.error}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={
                      "h-full " +
                      (item.status === "error"
                        ? "bg-destructive"
                        : "bg-primary")
                    }
                    style={{ width: item.progress + "%" }}
                  />
                </div>
                {item.status === "uploading" && (
                  <LoaderCircle className="size-4 animate-spin" />
                )}
                {item.status === "done" && (
                  <Check className="size-4 text-emerald-600" />
                )}
                {item.status === "error" && (
                  <span className="text-xs text-destructive">실패</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 sm:max-w-sm">
          <Search
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            className="pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="파일 이름 또는 형식 검색"
            aria-label="미디어 검색"
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {visible.length}개
          </span>
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            aria-label="정렬"
          >
            <option value="newest">최신순</option>
            <option value="oldest">오래된 순</option>
            <option value="name">이름순</option>
            <option value="largest">큰 파일순</option>
          </select>
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {busy && !files.length && (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed p-12 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          미디어를 불러오는 중…
        </div>
      )}
      {!busy && !visible.length && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <ImageIcon
            className="mx-auto mb-3 size-8 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="font-medium">
            {query ? "검색 결과가 없습니다" : "업로드된 파일이 없습니다"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {query
              ? "다른 검색어를 사용해 보세요."
              : "첫 이미지를 업로드해 미디어 라이브러리를 시작하세요."}
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visible.map((file) => (
          <Card key={file.id} className="group min-w-0 overflow-hidden">
            <a
              href={file.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/40"
            >
              {file.contentType.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={file.url}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                />
              ) : (
                <span className="text-muted-foreground [&_svg]:size-12">
                  <TypeIcon type={file.contentType} />
                </span>
              )}
            </a>
            <CardContent className="space-y-3 p-4">
              <div className="min-w-0">
                <p className="truncate font-medium" title={file.name}>
                  {file.name}
                </p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {formatBytes(file.size)} · {file.contentType}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {new Date(file.created_at).toLocaleString("ko-KR")}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  className="min-w-0 flex-1"
                  size="sm"
                  variant="outline"
                  onClick={() => void copy(file)}
                >
                  {copied === file.id ? <Check /> : <Copy />}
                  {copied === file.id ? "복사됨" : "URL 복사"}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-9 text-destructive hover:text-destructive"
                  aria-label={file.name + " 삭제"}
                  disabled={busy}
                  onClick={() => void remove(file)}
                >
                  <Trash2 />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
