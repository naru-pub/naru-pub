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
export default function DatabaseManager({
  site,
  websiteUrl,
}: {
  site: string;
  websiteUrl: string;
}) {
  const [view, setView] = useState("collections");
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
    <div className="mx-auto h-full w-full max-w-7xl overflow-auto p-4 space-y-6 sm:p-6 lg:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
        <div className="space-y-2 min-w-0">
          <p className="text-sm text-muted-foreground break-all">
            {site} · JSON 문서 저장소
          </p>
          <h1 className="text-2xl font-bold tracking-tight">데이터베이스</h1>
          <p className="text-sm text-muted-foreground">
            최대 10 MiB · 문서 10,000개 · 컬렉션 100개
          </p>
        </div>
        <a
          href="/database/docs/"
          className="border px-4 py-2 text-sm hover:bg-muted"
        >
          사용 안내 및 예제 블로그 →
        </a>
      </header>
      <nav aria-label="데이터베이스 메뉴" className="flex flex-wrap gap-2">
        {[
          ["collections", "컬렉션과 문서"],
          ["access", "웹사이트 관리자 로그인"],
          ["sdk", "웹 SDK"],
        ].map(([value, label]) => (
          <Button
            key={value}
            variant={view === value ? "default" : "outline"}
            aria-pressed={view === value}
            onClick={() => setView(value)}
          >
            {label}
          </Button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div hidden={view !== "collections"}>
        <fieldset
          disabled={busy}
          aria-busy={busy}
          className="grid min-w-0 gap-6 disabled:opacity-60 lg:grid-cols-[240px_minmax(0,1fr)]"
        >
          <aside className="min-w-0 space-y-4 border bg-muted/20 p-4 self-start">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">컬렉션</h2>
              <span className="text-sm text-muted-foreground">
                {collections.length} / 100
              </span>
            </div>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const created = newName;
                  await api("", "POST", { name: created });
                  setSelected(created);
                  setRead("admin");
                  setWrite("admin");
                  setId("");
                  setDocuments([]);
                  setCursor(null);
                  setNewName("");
                  await refresh();
                  await load(created);
                });
              }}
            >
              <label htmlFor="new-collection-name" className="text-sm font-medium">
                새 컬렉션 이름
              </label>
              <Input
                id="new-collection-name"
                aria-label="새 컬렉션 이름"
                placeholder="예: guestbook"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                pattern="[a-zA-Z0-9_-]{1,64}"
              />
              <Button type="submit">컬렉션 만들기</Button>
            </form>
            <div className="flex flex-col gap-2" aria-label="컬렉션 목록">
              {collections.map((c) => (
                <Button
                  key={c.name}
                  className="h-auto justify-start whitespace-normal break-all text-left"
                  aria-pressed={selected === c.name}
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
            {!collections.length && (
              <p className="text-sm text-muted-foreground">
                첫 컬렉션을 만들어 문서를 저장하세요.
              </p>
            )}
          </aside>
          <div className="min-w-0 space-y-5">
            {!selected && (
              <section className="border border-dashed p-10 text-center space-y-2">
                <h2 className="font-semibold">컬렉션을 선택하세요</h2>
                <p className="text-sm text-muted-foreground">
                  컬렉션을 선택하면 문서를 조회하고 편집할 수 있습니다.
                </p>
              </section>
            )}
            {selected && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-xl font-semibold break-all">
                    {selected}
                  </h2>
                  <span className="text-sm text-muted-foreground">
                    불러온 문서 {documents.length}개
                  </span>
                </div>
                <details className="border p-4 space-y-4">
                  <summary className="cursor-pointer font-medium">
                    접근 권한 및 컬렉션 설정
                  </summary>
                  <p className="text-sm text-muted-foreground">
                    공개 읽기는 누구나 조회할 수 있습니다. 공개 생성은 추가만,
                    전체 공개 쓰기는 덮어쓰기와 삭제까지 허용합니다.
                  </p>
                  <h2 className="font-bold">{selected} · 접근 권한</h2>
                  <div className="flex flex-wrap items-center gap-4">
                    <label>
                      읽기{" "}
                      <select
                        className="bg-background border p-2"
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
                        className="bg-background border p-2"
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
                </details>
                <div className="grid xl:grid-cols-2 gap-5 min-w-0">
                  <section className="min-w-0 border p-4 space-y-3">
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
                      <div className="border p-3 space-y-2" key={d.id}>
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
                    className="min-w-0 self-start border p-4 space-y-3"
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
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="font-bold">
                        {id ? "문서 편집" : "새 문서"}
                      </h2>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setId("");
                          setJson("{\n\n}");
                        }}
                      >
                        새 문서
                      </Button>
                    </div>
                    <Input
                      aria-label="문서 ID"
                      placeholder="문서 ID (비워두면 자동 생성)"
                      value={id}
                      pattern="[a-zA-Z0-9_-]{1,64}"
                      onChange={(e) => setId(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      기존 ID를 사용하면 문서 전체를 덮어씁니다. 요청 본문은
                      최대 64 KiB입니다.
                    </p>
                    <textarea
                      aria-label="JSON 데이터"
                      className="w-full h-80 border bg-background p-3 font-mono text-sm"
                      value={json}
                      onChange={(e) => setJson(e.target.value)}
                      spellCheck={false}
                    />
                    <Button type="submit">문서 저장</Button>
                  </form>
                </div>
              </>
            )}
          </div>
        </fieldset>
      </div>
      <div hidden={view !== "access"}>
        <WebsiteAccess collections={collections} websiteUrl={websiteUrl} />
      </div>
      <section hidden={view !== "sdk"} className="min-w-0 border p-5 space-y-4">
        <h2 className="font-bold">웹 SDK</h2>
        <p className="text-sm">
          사이트의 &lt;script type="module"&gt;에서 사용하세요. 기본
          클라이언트는 공개 권한만 사용합니다. 웹사이트 관리자 로그인은 위에서
          등록한 콜백 페이지에서 별도로 시작하세요. SDK는 관리자 쿠키를 전송하지
          않습니다.
        </p>
        <pre className="p-4 bg-muted overflow-auto text-sm">{snippet}</pre>
      </section>
    </div>
  );
}
