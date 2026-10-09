"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, X } from "lucide-react";
import { toast } from "sonner";
import { formatBytes } from "@/lib/board/constants";
import type { ApplicationPlan, ApplicationResult } from "@/lib/board/templates";
import { boardRequest } from "./api";

type Step =
  | { name: "where" }
  | { name: "review"; plan: ApplicationPlan }
  | { name: "done"; result: ApplicationResult };

export function ApplyTemplateDialog({
  title,
  slug,
  authorLoginName,
  versions,
  samplePath,
  siteUrl,
}: {
  title: string;
  slug: string;
  authorLoginName: string;
  versions: { id: string; version: number }[];
  // One of the template's files, to show where applying would put it.
  samplePath: string;
  // The viewer's site, or null when nobody is signed in.
  siteUrl: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ name: "where" });
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const [mode, setMode] = useState<"folder" | "root">("folder");
  const [folder, setFolder] = useState(slug);
  const [backup, setBackup] = useState(true);
  const [createCollections, setCreateCollections] = useState(true);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  const targetPath = mode === "root" ? "" : folder;
  const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, "");
  const targetPrefix = mode === "root" || !cleanFolder ? "" : `${cleanFolder}/`;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) close();
    };
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy]);

  function start() {
    if (!siteUrl) {
      router.push("/login");
      return;
    }
    setStep({ name: "where" });
    setOpen(true);
  }

  function close() {
    setOpen(false);
    openerRef.current?.focus();
  }

  async function review() {
    if (mode === "folder" && !folder.trim()) {
      toast.error("폴더 이름을 입력해 주세요.");
      return;
    }
    setBusy(true);
    try {
      const { plan } = await boardRequest<{ plan: ApplicationPlan }>(
        `/api/board/template-versions/${versionId}/apply/plan`,
        "POST",
        { targetPath },
      );
      setStep({ name: "review", plan });
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    try {
      const { result } = await boardRequest<{ result: ApplicationResult }>(
        `/api/board/template-versions/${versionId}/apply`,
        "POST",
        { targetPath, backup, createCollections },
      );
      setStep({ name: "done", result });
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  const overwrites =
    step.name === "review"
      ? step.plan.files.filter((file) => file.action === "overwrite")
      : [];

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        onClick={start}
        className="flex h-12 w-full items-center justify-center gap-2 bg-primary text-base font-bold text-primary-foreground hover:bg-primary/90"
      >
        <Download size={18} aria-hidden="true" /> 내 사이트에 적용
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:p-10">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="apply-title"
            tabIndex={-1}
            className="w-full max-w-2xl border-2 border-line bg-background text-foreground outline-none"
          >
            <div className="flex items-start justify-between gap-4 border-b-2 border-line bg-secondary px-5 py-4">
              <div className="min-w-0 space-y-1">
                <h2 id="apply-title" className="text-lg font-bold">
                  내 사이트에 적용
                </h2>
                <p className="truncate text-xs text-muted-foreground">
                  {title} · {authorLoginName}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                disabled={busy}
                aria-label="닫기"
                className="flex h-11 w-11 shrink-0 items-center justify-center border border-border text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>

            {step.name === "where" && (
              <div className="space-y-5 p-5">
                {versions.length > 1 && (
                  <div className="space-y-2">
                    <label
                      htmlFor="apply-version"
                      className="text-sm font-bold"
                    >
                      버전
                    </label>
                    <select
                      id="apply-version"
                      value={versionId}
                      onChange={(event) => setVersionId(event.target.value)}
                      className="h-11 w-full border border-border bg-background px-3 text-sm"
                    >
                      {versions.map((v, index) => (
                        <option key={v.id} value={v.id}>
                          v{v.version}
                          {index === 0 ? " (최신)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <fieldset className="space-y-3">
                  <legend className="mb-2 text-sm font-bold">
                    어디에 적용할까요?
                  </legend>
                  <label
                    className={`flex gap-3 border p-4 ${mode === "folder" ? "border-2 border-primary bg-primary/5" : "border-border"}`}
                  >
                    <input
                      type="radio"
                      name="apply-mode"
                      checked={mode === "folder"}
                      onChange={() => setMode("folder")}
                      className="mt-1 h-4 w-4 accent-primary"
                    />
                    <span className="min-w-0 flex-1 space-y-2">
                      <span className="block text-sm font-bold">
                        새 폴더에{" "}
                        <span className="font-normal text-muted-foreground">
                          — 기존 사이트는 그대로
                        </span>
                      </span>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <span className="truncate">{siteUrl}/</span>
                        <input
                          aria-label="폴더 이름"
                          value={folder}
                          onChange={(event) => {
                            setFolder(event.target.value);
                            setMode("folder");
                          }}
                          className="h-9 min-w-0 flex-1 border border-border bg-background px-2 text-sm text-foreground"
                        />
                        <span>/</span>
                      </span>
                    </span>
                  </label>
                  <label
                    className={`flex gap-3 border p-4 ${mode === "root" ? "border-2 border-primary bg-primary/5" : "border-border"}`}
                  >
                    <input
                      type="radio"
                      name="apply-mode"
                      checked={mode === "root"}
                      onChange={() => setMode("root")}
                      className="mt-1 h-4 w-4 accent-primary"
                    />
                    <span className="space-y-1">
                      <span className="block text-sm font-bold">
                        사이트 전체 (/){" "}
                        <span className="font-normal text-muted-foreground">
                          — 홈페이지가 이 템플릿으로 바뀌어요
                        </span>
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        겹치는 파일만 덮어쓰고, 나머지 파일은 건드리지 않아요.
                      </span>
                    </span>
                  </label>
                </fieldset>
                <p className="break-all border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  예: <code className="text-foreground">{samplePath}</code> →{" "}
                  <code className="text-foreground">
                    /{targetPrefix}
                    {samplePath}
                  </code>
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={close}
                    className="h-11 border border-border px-4 text-sm"
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    onClick={review}
                    disabled={busy}
                    className="h-11 bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-50"
                  >
                    {busy ? "확인하는 중…" : "바뀌는 파일 보기"}
                  </button>
                </div>
              </div>
            )}

            {step.name === "review" && (
              <div className="space-y-5 p-5">
                <div className="space-y-2">
                  <h3 className="text-sm font-bold">바뀌는 파일</h3>
                  <div className="max-h-72 overflow-y-auto border border-border">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-secondary text-left text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-normal">변경</th>
                          <th className="px-3 py-2 font-normal">경로</th>
                          <th className="px-3 py-2 text-right font-normal">
                            크기
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {step.plan.files.map((file) => (
                          <tr
                            key={file.path}
                            className="border-t border-border"
                          >
                            <td
                              className={`whitespace-nowrap px-3 py-2 font-bold ${file.action === "overwrite" ? "text-primary" : "text-success"}`}
                            >
                              {file.action === "overwrite"
                                ? "~ 덮어씀"
                                : "+ 새 파일"}
                            </td>
                            <td className="break-all px-3 py-2">
                              /{file.path}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground">
                              {formatBytes(file.sizeBytes)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {overwrites.length > 0 && (
                  <label className="flex gap-3 border border-border p-3 text-sm">
                    <input
                      type="checkbox"
                      checked={backup}
                      onChange={(event) => setBackup(event.target.checked)}
                      className="mt-1 h-4 w-4 accent-primary"
                    />
                    <span className="space-y-1">
                      <span className="block font-bold">
                        덮어쓰기 전에 원래 파일 보관
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        덮어쓰는 파일 {overwrites.length}개를 /.backup/ 폴더에
                        옮겨 둬요. 필요하면 파일 관리에서 꺼내 쓸 수 있어요.
                      </span>
                    </span>
                  </label>
                )}

                {step.plan.collections.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-bold">데이터</h3>
                    <label className="flex gap-3 border border-border p-3 text-sm">
                      <input
                        type="checkbox"
                        checked={createCollections}
                        onChange={(event) =>
                          setCreateCollections(event.target.checked)
                        }
                        disabled={
                          !step.plan.collections.some(
                            (c) => c.action === "create",
                          )
                        }
                        className="mt-1 h-4 w-4 accent-primary"
                      />
                      <span className="space-y-1">
                        <span className="block font-bold">
                          데이터베이스 컬렉션 만들기
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {step.plan.collections.map((c) => (
                            <span key={c.name} className="mr-3 inline-block">
                              <code className="text-foreground">{c.name}</code>{" "}
                              {c.action === "create"
                                ? "(새로 만듦)"
                                : c.action === "exists"
                                  ? "(이미 있음)"
                                  : "(데이터베이스 기능 필요)"}
                            </span>
                          ))}
                          <span className="block">
                            빈 컬렉션만 만들어요. 원작자의 데이터는 복사되지
                            않아요.
                          </span>
                        </span>
                      </span>
                    </label>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    새 파일 {step.plan.files.length - overwrites.length} ·
                    덮어씀 {overwrites.length}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setStep({ name: "where" })}
                      disabled={busy}
                      className="h-11 border border-border px-4 text-sm"
                    >
                      이전
                    </button>
                    <button
                      type="button"
                      onClick={apply}
                      disabled={busy}
                      className="h-11 bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-50"
                    >
                      {busy ? "적용하는 중…" : "적용하기"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {step.name === "done" && (
              <div className="space-y-4 p-5">
                <p className="text-base font-bold">적용했어요!</p>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  <li>파일 {step.result.written}개를 썼어요.</li>
                  {step.result.backupPath && (
                    <li>
                      원래 파일은 /{step.result.backupPath} 에 보관했어요.
                    </li>
                  )}
                  {step.result.createdCollections.length > 0 && (
                    <li>
                      컬렉션 {step.result.createdCollections.join(", ")} 을(를)
                      만들었어요.
                    </li>
                  )}
                  {step.result.skippedCollections.length > 0 && (
                    <li>
                      컬렉션 {step.result.skippedCollections.join(", ")} 은(는)
                      만들지 않았어요.
                    </li>
                  )}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <a
                    href={`${siteUrl}/${step.result.targetPath}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-11 items-center bg-primary px-4 text-sm font-bold text-primary-foreground"
                  >
                    내 사이트에서 보기 ↗
                  </a>
                  <button
                    type="button"
                    onClick={close}
                    className="h-11 border border-border px-4 text-sm"
                  >
                    닫기
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  원작자가 템플릿을 고쳐도 내 사이트는 바뀌지 않아요. 새 버전이
                  나오면 다시 적용하면 돼요.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
