"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import WebsiteAccess from "./WebsiteAccess";

type Collection = { name: string; read_access: string; write_access: string };
type Document = { id: string; data: unknown };
async function api(path = "", method = "GET", body?: unknown) {
  const response = await fetch(`/api/account/database${path}`, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
export default function DatabaseManager({ site }: { site: string }) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selected, setSelected] = useState("");
  const [newName, setNewName] = useState("");
  const [read, setRead] = useState("admin");
  const [write, setWrite] = useState("admin");
  const [documents, setDocuments] = useState<Document[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [json, setJson] = useState('{\n  "message": "안녕하세요!"\n}');
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState("");
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setCollections((await api()).collections);
  }
  async function load(collection: string, after?: string) {
    const result = await api(
      `/${collection}${after ? `?after=${encodeURIComponent(after)}` : ""}`,
    );
    setDocuments((previous) =>
      after ? [...previous, ...result.documents] : result.documents,
    );
    setCursor(result.nextCursor);
  }
  useEffect(() => {
    setOrigin(window.location.origin);
    void run(refresh);
  }, []);
  const snippet = `import { createDatabase } from "${origin}/sdk/1.0.0/naru-data.js";\nconst db = createDatabase({ site: ${JSON.stringify(site)} });\nconst entries = db.collection(${JSON.stringify(selected || "guestbook")});\nconst page = await entries.list();`;
  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6 overflow-auto h-full">
      <h1 className="text-2xl font-bold">데이터베이스</h1>
      <a
        href="/database/docs/"
        className="text-sm underline underline-offset-4"
      >
        사용 안내 및 예제 블로그 →
      </a>
      <p className="text-muted-foreground">
        사이트별 JSON 문서 저장소 · 최대 10 MiB / 문서 10,000개 / 컬렉션 100개
      </p>
      <p className="text-sm">
        관리자는 사이트 소유자입니다. 공개 생성만 허용하면 방문자는 문서를
        추가할 수 있지만 덮어쓰거나 삭제할 수 없습니다. 전체 공개 쓰기는
        생성·덮어쓰기·삭제를 모두 허용합니다. 공개 읽기를 허용한 데이터는 누구나
        볼 수 있습니다.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <fieldset disabled={busy} className="space-y-6 disabled:opacity-60">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("", "POST", { name: newName });
              setNewName("");
              await refresh();
            });
          }}
        >
          <Input
            aria-label="새 컬렉션 이름"
            placeholder="새 컬렉션 이름 (예: guestbook)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
            pattern="[a-zA-Z0-9_-]{1,64}"
          />
          <Button type="submit">컬렉션 만들기</Button>
        </form>
        <div className="flex gap-2 flex-wrap">
          {collections.map((c) => (
            <Button
              key={c.name}
              variant={selected === c.name ? "default" : "outline"}
              onClick={() =>
                void run(async () => {
                  setSelected(c.name);
                  setRead(c.read_access);
                  setWrite(c.write_access);
                  setId("");
                  setDocuments([]);
                  setCursor(null);
                  await load(c.name);
                })
              }
            >
              {c.name}
            </Button>
          ))}
        </div>
        {selected && (
          <>
            <section className="border rounded-lg p-4 space-y-4">
              <h2 className="font-bold">{selected} · 접근 권한</h2>
              <div className="flex flex-wrap items-center gap-4">
                <label>
                  읽기{" "}
                  <select
                    className="bg-background border rounded p-2"
                    value={read}
                    onChange={(e) => setRead(e.target.value)}
                  >
                    <option value="admin">관리자만</option>
                    <option value="world">누구나</option>
                  </select>
                </label>
                <label>
                  쓰기{" "}
                  <select
                    className="bg-background border rounded p-2"
                    value={write}
                    onChange={(e) => setWrite(e.target.value)}
                  >
                    <option value="admin">관리자만</option>
                    <option value="create">누구나 생성만</option>
                    <option value="world">누구나 생성·덮어쓰기·삭제</option>
                  </select>
                </label>
                <Button
                  onClick={() => {
                    if (
                      write === "world" &&
                      !window.confirm(
                        "누구나 이 컬렉션의 문서를 덮어쓰거나 삭제할 수 있습니다. 허용할까요?",
                      )
                    )
                      return;
                    void run(async () => {
                      await api(`/${selected}`, "PATCH", { read, write });
                      await refresh();
                    });
                  }}
                >
                  권한 저장
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (
                      window.confirm(
                        `컬렉션 ${selected} 및 모든 문서를 영구 삭제할까요?`,
                      )
                    )
                      void run(async () => {
                        await api(`/${selected}`, "DELETE");
                        setSelected("");
                        setDocuments([]);
                        await refresh();
                      });
                  }}
                >
                  컬렉션 삭제
                </Button>
              </div>
            </section>
            <div className="grid md:grid-cols-2 gap-6">
              <section className="space-y-3">
                <h2 className="font-bold">문서</h2>
                <Button
                  variant="outline"
                  onClick={() => void run(() => load(selected))}
                >
                  새로고침
                </Button>
                {!documents.length && (
                  <p className="text-muted-foreground">문서가 없습니다.</p>
                )}
                {documents.map((d) => (
                  <div className="border rounded p-3 space-y-2" key={d.id}>
                    <button
                      className="underline break-all text-left"
                      onClick={() => {
                        setId(d.id);
                        setJson(JSON.stringify(d.data, null, 2));
                      }}
                    >
                      {d.id}
                    </button>
                    <pre className="text-xs overflow-auto max-h-32">
                      {JSON.stringify(d.data, null, 2)}
                    </pre>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        if (window.confirm(`문서 ${d.id}를 삭제할까요?`))
                          void run(async () => {
                            await api(`/${selected}/${d.id}`, "DELETE");
                            await load(selected);
                          });
                      }}
                    >
                      삭제
                    </Button>
                  </div>
                ))}
                {cursor && (
                  <Button
                    variant="outline"
                    onClick={() => void run(() => load(selected, cursor))}
                  >
                    더 보기
                  </Button>
                )}
              </section>
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const data = JSON.parse(json);
                    await api(
                      `/${selected}${id ? `/${id}` : ""}`,
                      id ? "PUT" : "POST",
                      { data },
                    );
                    await load(selected);
                  });
                }}
              >
                <h2 className="font-bold">문서 만들기 / 편집</h2>
                <Input
                  aria-label="문서 ID"
                  placeholder="문서 ID (비워두면 자동 생성)"
                  value={id}
                  pattern="[a-zA-Z0-9_-]{1,64}"
                  onChange={(e) => setId(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  기존 ID를 사용하면 문서 전체를 덮어씁니다. 요청 본문은 최대 64
                  KiB입니다.
                </p>
                <textarea
                  aria-label="JSON 데이터"
                  className="w-full h-80 rounded border bg-background p-3 font-mono text-sm"
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  spellCheck={false}
                />
                <Button type="submit">문서 저장</Button>
              </form>
            </div>
          </>
        )}
      </fieldset>
      <WebsiteAccess collections={collections} />
      <section className="space-y-2">
        <h2 className="font-bold">웹 SDK</h2>
        <p className="text-sm">
          사이트의 &lt;script type="module"&gt;에서 사용하세요. 기본
          클라이언트는 공개 권한만 사용합니다. 웹사이트 관리자 로그인은 위에서
          등록한 콜백 페이지에서 별도로 시작하세요. SDK는 관리자 쿠키를 전송하지
          않습니다.
        </p>
        <pre className="p-4 bg-muted rounded overflow-auto text-sm">
          {snippet}
        </pre>
      </section>
    </div>
  );
}
