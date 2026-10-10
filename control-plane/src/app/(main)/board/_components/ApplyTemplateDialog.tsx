"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select } from "@/components/ui/select";
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

  const targetPath = mode === "root" ? "" : folder;
  const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, "");
  const targetPrefix = mode === "root" || !cleanFolder ? "" : `${cleanFolder}/`;

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
  const canCreateCollections =
    step.name === "review" &&
    step.plan.collections.some((c) => c.action === "create");
  const needsDatabase =
    step.name === "review" &&
    step.plan.collections.some((c) => c.action === "unavailable");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) setStep({ name: "where" });
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="lg"
          className="w-full"
          onClick={(event) => {
            if (!siteUrl) {
              event.preventDefault();
              router.push("/login");
            }
          }}
        >
          <Download aria-hidden="true" />
          내 사이트에 적용
        </Button>
      </DialogTrigger>

      <DialogContent
        ref={dialogRef}
        className="max-w-2xl outline-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dialogRef.current?.focus();
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle>내 사이트에 적용</DialogTitle>
          <DialogDescription className="truncate text-xs">
            {title} · {authorLoginName}
          </DialogDescription>
        </DialogHeader>

        {step.name === "where" && (
          <div className="space-y-5">
            {versions.length > 1 && (
              <div className="space-y-2">
                <label htmlFor="apply-version" className="text-sm font-bold">
                  버전
                </label>
                <Select
                  id="apply-version"
                  value={versionId}
                  onChange={(event) => setVersionId(event.target.value)}
                  wrapperClassName="w-full"
                >
                  {versions.map((v, index) => (
                    <option key={v.id} value={v.id}>
                      v{v.version}
                      {index === 0 ? " (최신)" : ""}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <fieldset className="space-y-3">
              <legend id="apply-mode" className="mb-2 text-sm font-bold">
                어디에 적용할까요?
              </legend>
              <RadioGroup
                aria-labelledby="apply-mode"
                value={mode}
                onValueChange={(value) => setMode(value as "folder" | "root")}
                className="gap-3"
              >
                <label
                  className={`flex cursor-pointer gap-3 border-2 p-4 ${mode === "folder" ? "border-primary bg-primary/5" : "border-border"}`}
                >
                  <RadioGroupItem value="folder" className="mt-0.5" />
                  <span className="min-w-0 flex-1 space-y-2">
                    <span className="block text-sm font-bold">
                      새 폴더에{" "}
                      <span className="font-normal text-muted-foreground">
                        — 기존 사이트는 그대로
                      </span>
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="truncate">{siteUrl}/</span>
                      <Input
                        aria-label="폴더 이름"
                        value={folder}
                        onChange={(event) => {
                          setFolder(event.target.value);
                          setMode("folder");
                        }}
                        className="h-9 min-w-0 flex-1 px-2 text-foreground"
                      />
                      <span>/</span>
                    </span>
                  </span>
                </label>
                <label
                  className={`flex cursor-pointer gap-3 border-2 p-4 ${mode === "root" ? "border-primary bg-primary/5" : "border-border"}`}
                >
                  <RadioGroupItem value="root" className="mt-0.5" />
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
              </RadioGroup>
            </fieldset>
            <p className="break-all border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              예: <code className="text-foreground">{samplePath}</code> →{" "}
              <code className="text-foreground">
                /{targetPrefix}
                {samplePath}
              </code>
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">취소</Button>
              </DialogClose>
              <Button onClick={review} disabled={busy}>
                {busy ? "확인하는 중…" : "바뀌는 파일 보기"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step.name === "review" && (
          <div className="space-y-5">
            <div className="space-y-2">
              <h3 className="text-sm font-bold">바뀌는 파일</h3>
              <div className="max-h-72 overflow-y-auto border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-secondary text-left text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-normal">변경</th>
                      <th className="px-3 py-2 font-normal">경로</th>
                      <th className="px-3 py-2 text-right font-normal">크기</th>
                    </tr>
                  </thead>
                  <tbody>
                    {step.plan.files.map((file) => (
                      <tr key={file.path} className="border-t border-border">
                        <td
                          className={`whitespace-nowrap px-3 py-2 font-bold ${file.action === "overwrite" ? "text-primary" : "text-success"}`}
                        >
                          {file.action === "overwrite" ? "~ 덮어씀" : "+ 새 파일"}
                        </td>
                        <td className="break-all px-3 py-2">/{file.path}</td>
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
              <label className="flex cursor-pointer gap-3 border border-border p-3 text-sm">
                <Checkbox
                  checked={backup}
                  onCheckedChange={(checked) => setBackup(checked === true)}
                  className="mt-0.5"
                />
                <span className="space-y-1">
                  <span className="block font-bold">
                    덮어쓰기 전에 원래 파일 보관
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    덮어쓰는 파일 {overwrites.length}개를 /.backup/ 폴더에 옮겨
                    둬요. 필요하면 파일 관리에서 꺼내 쓸 수 있어요.
                  </span>
                </span>
              </label>
            )}

            {step.plan.collections.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-bold">데이터</h3>
                <label className="flex gap-3 border border-border p-3 text-sm">
                  <Checkbox
                    checked={createCollections && canCreateCollections}
                    onCheckedChange={(checked) =>
                      setCreateCollections(checked === true)
                    }
                    disabled={!canCreateCollections}
                    className="mt-0.5"
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
                        빈 컬렉션만 만들어요. 원작자의 데이터는 복사되지 않아요.
                      </span>
                    </span>
                  </span>
                </label>
                {needsDatabase && (
                  <p className="border border-border bg-muted p-3 text-sm">
                    이 템플릿의 일부 기능은 데이터베이스가 필요해요. 파일은
                    적용되지만, 컬렉션을 쓰는 기능은 데이터베이스 없이 동작하지
                    않아요.{" "}
                    <Link href="/supporter" className="font-bold underline">
                      서포터 플랜 알아보기
                    </Link>
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                새 파일 {step.plan.files.length - overwrites.length} · 덮어씀{" "}
                {overwrites.length}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setStep({ name: "where" })}
                  disabled={busy}
                >
                  이전
                </Button>
                <Button onClick={apply} disabled={busy}>
                  {busy ? "적용하는 중…" : "적용하기"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {step.name === "done" && (
          <div className="space-y-4">
            <p className="text-base font-bold">적용했어요!</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>파일 {step.result.written}개를 썼어요.</li>
              {step.result.backupPath && (
                <li>원래 파일은 /{step.result.backupPath} 에 보관했어요.</li>
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
              {step.result.unavailableCollections.length > 0 && (
                <li>
                  컬렉션 {step.result.unavailableCollections.join(", ")} 은(는)
                  데이터베이스 기능이 필요해서 만들지 않았어요. 이 컬렉션을 쓰는
                  기능은 동작하지 않아요.{" "}
                  <Link
                    href="/supporter"
                    className="font-bold text-foreground underline"
                  >
                    서포터 플랜 알아보기
                  </Link>
                </li>
              )}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <a
                  href={`${siteUrl}/${step.result.targetPath}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  내 사이트에서 보기 ↗
                </a>
              </Button>
              <DialogClose asChild>
                <Button variant="outline">닫기</Button>
              </DialogClose>
            </div>
            <p className="text-xs text-muted-foreground">
              원작자가 템플릿을 고쳐도 내 사이트는 바뀌지 않아요. 새 버전이
              나오면 다시 적용하면 돼요.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
