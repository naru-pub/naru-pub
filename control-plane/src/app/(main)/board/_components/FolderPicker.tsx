"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { FileNode } from "@/lib/fileUtils";

// The deepest folder holding every path, as "a/b", or "" when they sit in
// different places. The server narrows a template to the same folder.
export function commonFolder(paths: string[]): string {
  if (paths.length === 0) return "";
  let common = paths[0].split("/").slice(0, -1);
  for (const path of paths.slice(1)) {
    const directories = path.split("/").slice(0, -1);
    let shared = 0;
    while (
      shared < common.length &&
      shared < directories.length &&
      common[shared] === directories[shared]
    ) {
      shared++;
    }
    common = common.slice(0, shared);
  }
  return common.join("/");
}

function filesUnder(node: FileNode): string[] {
  if (!node.isDirectory) return [node.path];
  return (node.children ?? []).flatMap(filesUnder);
}

function isBackup(node: FileNode) {
  return node.path === ".backup" || node.path.startsWith(".backup/");
}

// The person's whole site as a tree, nothing checked: they check the files
// or folders to share. The value is the checked files' paths.
export function FolderPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [tree, setTree] = useState<FileNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/files/tree")
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success) {
          const nodes: FileNode[] = data.files.filter(
            (node: FileNode) => !isBackup(node),
          );
          setTree(nodes);
          // Open the folders that hold what is already checked.
          const open = new Set<string>();
          for (const path of value) {
            const parts = path.split("/").slice(0, -1);
            for (let i = 1; i <= parts.length; i++) {
              open.add(parts.slice(0, i).join("/"));
            }
          }
          setExpanded(open);
        } else {
          setError(data.message ?? "파일 목록을 불러올 수 없습니다.");
        }
      })
      .catch(() => !cancelled && setError("파일 목록을 불러올 수 없습니다."));
    return () => {
      cancelled = true;
    };
    // The initial selection only decides which folders start open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(() => new Set(value), [value]);
  const root = commonFolder(value);

  function setFiles(paths: string[], checked: boolean) {
    const next = new Set(selected);
    for (const path of paths) {
      if (checked) next.add(path);
      else next.delete(path);
    }
    onChange([...next].sort());
  }

  function toggleOpen(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderNodes(nodes: FileNode[], depth: number): React.ReactNode {
    return nodes
      .filter((node) => !isBackup(node))
      .map((node) => {
        const files = filesUnder(node);
        const count = files.filter((path) => selected.has(path)).length;
        const checked = files.length > 0 && count === files.length;
        const partial = count > 0 && !checked;
        const open = expanded.has(node.path);
        return (
          <li key={node.path}>
            <div
              className="flex h-9 items-center gap-1 border-b border-border/60 pr-3 text-sm"
              style={{ paddingLeft: `${0.25 + depth * 1.25}rem` }}
            >
              {node.isDirectory ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => toggleOpen(node.path)}
                  aria-label={
                    open ? `${node.name} 접기` : `${node.name} 펼치기`
                  }
                  aria-expanded={open}
                  className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  {open ? <ChevronDown /> : <ChevronRight />}
                </Button>
              ) : (
                <span className="w-8 shrink-0" />
              )}
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <Checkbox
                  checked={partial ? "indeterminate" : checked}
                  disabled={files.length === 0}
                  onCheckedChange={() => setFiles(files, !checked)}
                  className="data-[state=indeterminate]:bg-primary data-[state=indeterminate]:shadow-[inset_0_0_0_3px_hsl(var(--card))] data-[state=indeterminate]:[&_svg]:hidden"
                />
                <span
                  className={`truncate ${count > 0 ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {node.name}
                  {node.isDirectory ? "/" : ""}
                </span>
                {node.isDirectory && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {count > 0
                      ? `${count}/${files.length}`
                      : `파일 ${files.length}개`}
                  </span>
                )}
              </label>
            </div>
            {node.isDirectory && open && node.children?.length ? (
              <ul>{renderNodes(node.children, depth + 1)}</ul>
            ) : null}
          </li>
        );
      });
  }

  if (error) {
    return (
      <p className="border border-destructive p-3 text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (!tree) {
    return (
      <p className="border border-border p-3 text-sm text-muted-foreground">
        파일 목록을 불러오는 중…
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <span className="text-sm font-bold">템플릿으로 공유할 파일</span>
      <p className="text-xs text-muted-foreground">
        공유할 파일이나 폴더를 체크해 주세요. 비공개 초안이나 개인 정보가 든
        파일은 빼 주세요.
      </p>
      <div className="max-h-96 overflow-y-auto border border-border">
        {tree.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            내 사이트에 파일이 없어요.
          </p>
        ) : (
          <ul>{renderNodes(tree, 0)}</ul>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {value.length === 0
          ? "아직 고른 파일이 없어요."
          : `파일 ${value.length}개 · 템플릿의 최상위 폴더: /${root ? `${root}/` : ""}`}
      </p>
    </div>
  );
}
