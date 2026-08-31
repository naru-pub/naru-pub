"use client";
import { useState } from "react";
import type { AuthorizationInput } from "@/lib/site-data/owner-auth";
import { Button } from "@/components/ui/button";
export default function Consent({
  input,
  names,
  tokenLifetimeSeconds,
}: {
  input: AuthorizationInput;
  names: string[];
  tokenLifetimeSeconds: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const duration =
    tokenLifetimeSeconds % 3600 === 0
      ? `${tokenLifetimeSeconds / 3600}시간`
      : `${tokenLifetimeSeconds / 60}분`;
  async function approve() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/data-auth/authorize", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, tokenLifetimeSeconds }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      window.location.assign(result.redirect);
    } catch (e) {
      setError(e instanceof Error ? e.message : "승인에 실패했습니다.");
      setBusy(false);
    }
  }
  function deny() {
    const url = new URL(input.redirectUri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("state", input.state);
    window.location.assign(url.href);
  }
  return (
    <div className="max-w-xl mx-auto p-6 space-y-5">
      <h1 className="text-2xl font-bold">웹사이트 관리자 접근 승인</h1>
      <p>
        사이트 <strong>{input.site}</strong>의 데이터에 아래 웹사이트가 최대
        {duration} 동안 접근할 수 있도록 허용할까요?
      </p>
      <p className="break-all rounded bg-muted p-3">{input.redirectUri}</p>
      <p>
        허용할 컬렉션: <strong>{names.join(", ")}</strong>
      </p>
      <p>
        이 웹사이트에서 위 컬렉션의 모든 문서를 읽고, 생성하고, 덮어쓰고, 삭제할
        수 있습니다. 비공개 문서도 포함됩니다. 계정 설정이나 컬렉션 권한은
        변경할 수 없습니다.
      </p>
      <p className="text-sm text-muted-foreground">
        웹사이트에 포함된 외부 스크립트도 이 권한을 사용할 수 있습니다. 신뢰하는
        편집 페이지에서만 승인하세요.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <Button disabled={busy} onClick={approve}>
          최대 {duration} 동안 허용
        </Button>
        <Button disabled={busy} variant="outline" onClick={deny}>
          취소
        </Button>
      </div>
    </div>
  );
}
