"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { MAX_CHANGELOG_LENGTH } from "@/lib/board/constants";
import { boardRequest } from "../../_components/api";
import { FolderPicker } from "../../_components/FolderPicker";
import CollectionName from "@/components/CollectionName";

export function NewVersionForm({
  templateId,
  postId,
  initialFiles,
  missingFiles,
  collections,
  initialCollections,
}: {
  templateId: string;
  postId: string;
  // The previous version's files, checked to start with.
  initialFiles: string[];
  // The previous version's files no longer on the site, left unchecked.
  missingFiles: string[];
  collections: string[];
  initialCollections: string[];
}) {
  const router = useRouter();
  const [selection, setSelection] = useState<string[]>(initialFiles);
  const [changelog, setChangelog] = useState("");
  const [chosen, setChosen] = useState<string[]>(
    initialCollections.filter((name) => collections.includes(name)),
  );
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const { version } = await boardRequest<{ version: number }>(
        `/api/board/templates/${templateId}/versions`,
        "POST",
        {
          files: selection,
          changelog,
          collections: chosen,
        },
      );
      toast.success(`v${version}을(를) 올렸어요.`);
      router.push(`/board/${postId}`);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {missingFiles.length > 0 && (
        <p className="border border-border p-3 text-sm text-muted-foreground [overflow-wrap:anywhere]">
          지난 버전의 파일 중 {missingFiles.length}개는 사이트에 없어서 빼고
          시작해요: {missingFiles.join(", ")}. 폴더를 옮겼다면 새 위치에서 골라
          주세요.
        </p>
      )}
      <FolderPicker value={selection} onChange={setSelection} />
      {collections.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-bold">
            함께 쓸 데이터베이스 컬렉션
          </legend>
          <div className="flex flex-wrap gap-2">
            {collections.map((name) => (
              <label
                key={name}
                className="flex min-h-10 min-w-0 cursor-pointer items-center gap-2 border border-border px-3 py-2 text-sm"
              >
                <Checkbox
                  className="shrink-0"
                  checked={chosen.includes(name)}
                  onCheckedChange={(checked) =>
                    setChosen((current) =>
                      checked === true
                        ? [...current, name]
                        : current.filter((c) => c !== name),
                    )
                  }
                />
                <code className="min-w-0">
                  <CollectionName name={name} />
                </code>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="space-y-2">
        <label htmlFor="changelog" className="text-sm font-bold">
          바뀐 점
        </label>
        <Textarea
          id="changelog"
          value={changelog}
          onChange={(event) => setChangelog(event.target.value)}
          maxLength={MAX_CHANGELOG_LENGTH}
          rows={3}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={busy} className="text-sm">
          {busy ? "파일을 복사하는 중…" : "새 버전 올리기"}
        </Button>
      </div>
    </form>
  );
}
