"use client";

import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { CheckCircle2, Copy, Github, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  displayRef,
  githubWorkflowYaml,
  normalizeWorkflowTargetPrefix,
} from "@/lib/deploy/githubWorkflow";

type GitHubDeployTarget = {
  id: string;
  githubRepository: string;
  githubRef: string;
  targetPrefix: string;
  enabled: boolean;
  lastGithubSha: string | null;
  lastDeployedAt: string | null;
};

type GitHubDeployment = {
  id: string;
  status: string;
  githubRepository: string;
  githubRef: string;
  githubSha: string;
  targetPrefix: string;
  fileCount: number;
  uploadedFileCount: number;
  deletedFileCount: number;
  errorMessage: string | null;
  createdAt: string;
  finalizedAt: string | null;
};

function refFromBranch(branch: string) {
  const trimmed = branch.trim();
  if (trimmed.startsWith("refs/heads/") || trimmed.startsWith("refs/tags/")) {
    return trimmed;
  }
  return `refs/heads/${trimmed || "main"}`;
}

function statusLabel(status: string) {
  if (status === "finalized") return "성공";
  if (status === "failed") return "실패";
  if (status === "expired") return "만료";
  return "진행 중";
}

export default function GitHubDeployTargetsCard({
  loginName,
  targets,
  deployments,
}: {
  loginName: string;
  targets: GitHubDeployTarget[];
  deployments: GitHubDeployment[];
}) {
  const [githubRepository, setGithubRepository] = useState("");
  const [branch, setBranch] = useState("main");
  const [targetPrefix, setTargetPrefix] = useState("/");
  const [pendingId, setPendingId] = useState<string | null>(null);

  const sortedTargets = useMemo(
    () => targets.filter((target) => target.enabled),
    [targets],
  );

  async function addTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPendingId("new");

    try {
      const response = await fetch("/api/account/github-deploy-targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          githubRepository,
          githubRef: refFromBranch(branch),
          targetPrefix,
        }),
      });
      const result = await response.json();

      if (result.success) {
        toast.success("GitHub 배포 대상이 저장되었습니다.");
        setGithubRepository("");
        setBranch("main");
        setTargetPrefix("/");
        window.location.reload();
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("GitHub 배포 대상 저장 중 오류가 발생했습니다.");
    } finally {
      setPendingId(null);
    }
  }

  async function deleteTarget(id: string) {
    setPendingId(id);

    try {
      const response = await fetch("/api/account/github-deploy-targets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const result = await response.json();

      if (result.success) {
        toast.success("GitHub 배포 대상이 삭제되었습니다.");
        window.location.reload();
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("GitHub 배포 대상 삭제 중 오류가 발생했습니다.");
    } finally {
      setPendingId(null);
    }
  }

  async function copyWorkflow(target: GitHubDeployTarget) {
    await navigator.clipboard.writeText(githubWorkflowYaml(loginName, target));
    toast.success("워크플로를 복사했습니다.");
  }

  return (
    <Card className="bg-card border-2 border-border shadow-lg">
      <CardHeader className="bg-secondary border-b-2 border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <Github size={20} />
          GitHub 배포
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        <div className="bg-muted border border-border rounded p-3 text-sm text-muted-foreground space-y-2">
          <p>GitHub Actions에서 빌드한 파일을 나루로 배포할 수 있습니다.</p>
          <p>
            저장소와 브랜치를 등록하면 해당 워크플로만 이 계정에 배포할 수
            있습니다.
          </p>
        </div>

        <form onSubmit={addTarget} className="grid gap-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_160px_140px_auto] sm:items-end">
            <div className="space-y-1">
              <Label htmlFor="github-repository">저장소</Label>
              <Input
                id="github-repository"
                value={githubRepository}
                onChange={(event) => setGithubRepository(event.target.value)}
                placeholder="owner/repo"
                disabled={pendingId !== null}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="github-branch">브랜치</Label>
              <Input
                id="github-branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="main"
                disabled={pendingId !== null}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="github-target-prefix">대상</Label>
              <Input
                id="github-target-prefix"
                value={targetPrefix}
                onChange={(event) => setTargetPrefix(event.target.value)}
                placeholder="/"
                disabled={pendingId !== null}
              />
            </div>
            <Button
              type="submit"
              disabled={pendingId !== null || githubRepository.trim() === ""}
              className="flex items-center gap-2"
            >
              <Plus size={16} />
              추가
            </Button>
          </div>
        </form>

        <div className="space-y-3">
          {sortedTargets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              등록된 GitHub 배포 대상이 없습니다.
            </p>
          ) : (
            sortedTargets.map((target) => {
              const yaml = githubWorkflowYaml(loginName, target);

              return (
                <div
                  key={target.id}
                  className="border border-border rounded p-3 space-y-3"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-foreground break-all">
                          {target.githubRepository}
                        </p>
                        <Badge variant="secondary">
                          {displayRef(target.githubRef)}
                        </Badge>
                        <Badge variant="outline">
                          {normalizeWorkflowTargetPrefix(target.targetPrefix)}
                        </Badge>
                      </div>
                      {target.lastDeployedAt ? (
                        <p className="text-sm text-muted-foreground flex items-center gap-1">
                          <CheckCircle2 size={14} />
                          마지막 배포:{" "}
                          {new Date(target.lastDeployedAt).toLocaleString()}
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          아직 배포된 적이 없습니다.
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => copyWorkflow(target)}
                        disabled={pendingId !== null}
                        className="flex items-center gap-2"
                      >
                        <Copy size={14} />
                        복사
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => deleteTarget(target.id)}
                        disabled={pendingId !== null}
                        className="flex items-center gap-2"
                      >
                        <Trash2 size={14} />
                        삭제
                      </Button>
                    </div>
                  </div>

                  <pre className="bg-background border border-border rounded p-3 text-xs overflow-x-auto whitespace-pre">
                    {yaml}
                  </pre>
                </div>
              );
            })
          )}
        </div>

        <div className="space-y-3 border-t border-border pt-5">
          <div>
            <h3 className="font-semibold text-foreground">최근 배포</h3>
            <p className="text-sm text-muted-foreground">
              최근 20개의 GitHub 배포 시도와 오류를 확인할 수 있습니다.
            </p>
          </div>
          {deployments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              아직 기록된 배포가 없습니다.
            </p>
          ) : (
            <div className="divide-y divide-border rounded border border-border">
              {deployments.map((deployment) => (
                <div key={deployment.id} className="space-y-2 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <Badge
                        variant={
                          deployment.status === "failed" ||
                          deployment.status === "expired"
                            ? "destructive"
                            : deployment.status === "finalized"
                              ? "default"
                              : "secondary"
                        }
                      >
                        {statusLabel(deployment.status)}
                      </Badge>
                      <span className="font-medium break-all">
                        {deployment.githubRepository}
                      </span>
                      <code title={deployment.githubSha}>
                        {deployment.githubSha.slice(0, 7)}
                      </code>
                    </div>
                    <time
                      className="text-muted-foreground"
                      dateTime={deployment.createdAt}
                    >
                      {new Date(deployment.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <p className="text-muted-foreground">
                    {displayRef(deployment.githubRef)} →{" "}
                    {normalizeWorkflowTargetPrefix(deployment.targetPrefix)} ·{" "}
                    {deployment.fileCount}개 파일
                    {deployment.uploadedFileCount < deployment.fileCount
                      ? ` · ${deployment.uploadedFileCount}개 변경`
                      : ""}
                    {deployment.deletedFileCount > 0
                      ? ` · ${deployment.deletedFileCount}개 삭제`
                      : ""}
                  </p>
                  {deployment.errorMessage ? (
                    <p className="rounded bg-destructive/10 px-2 py-1 text-destructive break-words">
                      {deployment.errorMessage}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
