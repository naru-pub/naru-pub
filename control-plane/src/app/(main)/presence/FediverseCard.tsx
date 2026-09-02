"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AtSign, Copy } from "lucide-react";
import { toast } from "sonner";

export interface FediverseFollower {
  handle: string;
  url: string;
}

export default function FediverseCard({
  loginName,
  domain,
  followers,
}: {
  loginName: string;
  domain: string;
  followers: FediverseFollower[];
}) {
  const handle = `@${loginName}@${domain}`;

  async function copyHandle() {
    try {
      await navigator.clipboard.writeText(handle);
      toast.success("핸들이 복사되었습니다.");
    } catch {
      toast.error("복사에 실패했습니다.");
    }
  }

  return (
    <Card className="bg-card border-2 border-border shadow-lg">
      <CardHeader className="bg-secondary border-b-2 border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <AtSign size={20} />
          연합우주
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        <div className="bg-muted border border-border rounded p-3 flex items-center justify-between gap-3">
          <code className="text-foreground text-base font-mono">{handle}</code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copyHandle}
            className="flex items-center gap-2"
          >
            <Copy size={14} />
            복사
          </Button>
        </div>
        <p className="text-muted-foreground text-sm leading-relaxed">
          마스토돈을 비롯한 연합우주 서버에서 위 핸들로 팔로우할 수 있습니다.
          사이트를 수정하면 팔로워들에게 하루 한 번까지 업데이트 알림이
          전송됩니다.
        </p>
        <div className="bg-background border border-border rounded p-3 space-y-3">
          <p className="text-muted-foreground text-sm">
            팔로워 <strong className="text-primary">{followers.length}</strong>
            명
          </p>
          {followers.length > 0 && (
            <ul className="space-y-1 text-sm font-mono">
              {followers.map((f) => (
                <li key={f.url}>
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline break-all"
                  >
                    {f.handle}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
