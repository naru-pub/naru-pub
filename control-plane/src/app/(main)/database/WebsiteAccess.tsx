"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Client = {
  id: string;
  redirectUri: string;
  collections: string[];
  tokenLifetimeSeconds: number;
};
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
  const [lifetimeMinutes, setLifetimeMinutes] = useState("1440");
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
    <section className="space-y-5">
      <h2 className="text-xl font-semibold">웹사이트 관리자 로그인</h2>
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
      <p className="border bg-muted/30 p-4 text-sm break-all">
        Client ID: <code>{clientId || "불러오는 중…"}</code>
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <fieldset
        disabled={busy}
        className="grid min-w-0 items-start gap-6 lg:grid-cols-2"
      >
        <form
          className="min-w-0 border p-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(editing ? "PATCH" : "POST", {
                ...(editing ? { id: editing } : {}),
                redirectUri: callback,
                tokenLifetimeSeconds: Number(lifetimeMinutes) * 60,
                collections: selected.filter((n) =>
                  collections.some((c) => c.name === n),
                ),
              });
              setEditing(null);
              setCallback(websiteUrl);
              setSelected([]);
              setLifetimeMinutes("1440");
              await reload();
            });
          }}
        >
          <h3 className="font-semibold">
            {editing ? "관리자 페이지 수정" : "관리자 페이지 등록"}
          </h3>
          <label
            htmlFor="admin-callback-url"
            className="block text-sm font-medium"
          >
            관리자 페이지 URL
          </label>
          <Input
            id="admin-callback-url"
            aria-label="관리자 로그인 콜백 URL"
            type="url"
            required
            placeholder={`${websiteUrl}admin.html`}
            value={callback}
            onChange={(e) => setCallback(e.target.value)}
          />
          <label className="block space-y-1 text-sm">
            <span>관리자 토큰 유효 시간 (분)</span>
            <Input
              type="number"
              min={1}
              max={1440}
              step={1}
              required
              value={lifetimeMinutes}
              onChange={(e) => setLifetimeMinutes(e.target.value)}
            />
            <span className="text-muted-foreground">
              1–1,440분, 기본 24시간. 나루 로그인 세션이 먼저 만료되면 토큰도
              종료됩니다.
            </span>
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              접근을 허용할 컬렉션
            </legend>
            {!collections.length && (
              <p className="text-sm text-muted-foreground">
                먼저 컬렉션을 만들어 주세요.
              </p>
            )}
            <div className="flex gap-3 flex-wrap">
              {collections.map((c) => (
                <label
                  className="flex min-w-0 gap-2 items-center border px-3 py-2 text-sm break-all"
                  key={c.name}
                >
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
          </fieldset>
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
                setLifetimeMinutes("1440");
              }}
            >
              수정 취소
            </Button>
          )}
        </form>
        <section className="min-w-0 space-y-3">
          <h3 className="font-semibold">
            등록된 관리자 페이지{" "}
            <span className="text-muted-foreground">{clients.length}</span>
          </h3>
          {!clients.length && (
            <p className="border border-dashed p-6 text-sm text-muted-foreground">
              등록된 관리자 페이지가 없습니다.
            </p>
          )}
          {clients.map((c) => (
            <div className="border p-4 space-y-3" key={c.id}>
              <p className="break-all">{c.redirectUri}</p>
              <p className="text-sm">
                컬렉션: {c.collections.join(", ") || "(삭제됨)"}
              </p>
              <p className="text-sm">
                토큰 유효 시간: {c.tokenLifetimeSeconds / 60}분
              </p>
              <div className="flex gap-2 flex-wrap">
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditing(c.id);
                    setCallback(c.redirectUri);
                    setSelected(c.collections);
                    setLifetimeMinutes(String(c.tokenLifetimeSeconds / 60));
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
                          setLifetimeMinutes("1440");
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
        </section>
      </fieldset>
    </section>
  );
}
