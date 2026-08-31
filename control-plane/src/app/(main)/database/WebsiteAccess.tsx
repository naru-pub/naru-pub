"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Client = { id: string; redirectUri: string; collections: string[] };
async function api(method = "GET", body?: unknown) {
  const response = await fetch("/api/account/database-clients", {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
export default function WebsiteAccess({
  collections,
  websiteUrl,
}: {
  collections: { name: string }[];
  websiteUrl: string;
}) {
  const [clientId, setClientId] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [callback, setCallback] = useState(websiteUrl);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    const result = await api();
    setClients(result.clients);
    setClientId(result.clientId);
  };
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(reload);
  }, []);
  return (
    <section className="border rounded-lg p-4 space-y-4">
      <h2 className="font-bold">웹사이트 관리자 로그인</h2>
      <p className="text-sm">
        웹사이트의 관리자 페이지를 등록하세요. 나루에서 소유자가 승인하면 선택한
        컬렉션의 문서를 읽고 변경할 수 있는 최대 24시간 동안 유지되는 권한을
        받습니다. 계정이나 컬렉션 권한 설정은 변경할 수 없습니다.
      </p>
      <p className="text-sm text-muted-foreground">
        본인의 나루 주소 또는 활성화된 인증 도메인만 사용할 수 있습니다. 콜백
        URL에는 쿼리나 #을 넣지 마세요. 외부 스크립트가 없는 신뢰할 수 있는
        관리자 페이지를 사용하세요.
      </p>
      <p className="text-sm break-all">
        웹사이트 공통 Client ID: <code>{clientId || "불러오는 중…"}</code>
      </p>
      <p className="text-sm text-muted-foreground">
        관리자 페이지를 추가하거나 수정해도 Client ID는 바뀌지 않습니다.
        페이지를 수정하면 해당 페이지의 로그인 권한을 모두 취소합니다.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <fieldset disabled={busy} className="space-y-4">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(editing ? "PATCH" : "POST", {
                ...(editing ? { id: editing } : {}),
                redirectUri: callback,
                collections: selected.filter((n) =>
                  collections.some((c) => c.name === n),
                ),
              });
              setEditing(null);
              setCallback(websiteUrl);
              setSelected([]);
              await reload();
            });
          }}
        >
          <Input
            aria-label="관리자 로그인 콜백 URL"
            type="url"
            required
            placeholder={`${websiteUrl}admin.html`}
            value={callback}
            onChange={(e) => setCallback(e.target.value)}
          />
          <div className="flex gap-3 flex-wrap">
            {collections.map((c) => (
              <label className="flex gap-2 items-center" key={c.name}>
                <input
                  type="checkbox"
                  checked={selected.includes(c.name)}
                  onChange={(e) =>
                    setSelected((current) =>
                      e.target.checked
                        ? [...current, c.name]
                        : current.filter((n) => n !== c.name),
                    )
                  }
                />
                {c.name}
              </label>
            ))}
          </div>
          <Button type="submit" disabled={!selected.length}>
            {editing ? "관리자 페이지 수정" : "관리자 페이지 등록"}
          </Button>
          {editing && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditing(null);
                setCallback(websiteUrl);
                setSelected([]);
              }}
            >
              수정 취소
            </Button>
          )}
        </form>
        {clients.map((c) => (
          <div className="border rounded p-3 space-y-2" key={c.id}>
            <p className="break-all">{c.redirectUri}</p>
            <p className="text-sm">
              컬렉션: {c.collections.join(", ") || "(삭제됨)"}
            </p>
            <div className="flex gap-2 flex-wrap">
              <Button
                variant="outline"
                onClick={() => {
                  setEditing(c.id);
                  setCallback(c.redirectUri);
                  setSelected(c.collections);
                }}
              >
                수정
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void run(async () => {
                    await api("PATCH", { id: c.id });
                    setNotice("발급된 로그인 권한을 모두 취소했습니다.");
                  })
                }
              >
                모든 로그인 권한 취소
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (
                    window.confirm(
                      "이 웹사이트 등록을 제거하고 발급된 권한을 모두 취소할까요?",
                    )
                  )
                    void run(async () => {
                      await api("DELETE", { id: c.id });
                      if (editing === c.id) {
                        setEditing(null);
                        setCallback(websiteUrl);
                        setSelected([]);
                      }
                      await reload();
                    });
                }}
              >
                등록 제거
              </Button>
            </div>
          </div>
        ))}
      </fieldset>
    </section>
  );
}
