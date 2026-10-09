"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { safeNextPath } from "@/lib/next-path";
import { CheckCircle, XCircle, Loader } from "lucide-react";

type Outcome = { status: "success" | "error"; message: string };

export default function VerifyEmailPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  // Where the verification was asked from — the purchase page — if anywhere.
  const next = safeNextPath(searchParams.get("next"));
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    if (!token) return;
    // A late response must not land on an unmounted page or a newer token.
    let current = true;
    fetch("/api/account/verify-email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    })
      .then((response) => response.json())
      .then((result) => {
        if (current)
          setOutcome({
            status: result.success ? "success" : "error",
            message: result.message,
          });
      })
      .catch(() => {
        if (current)
          setOutcome({
            status: "error",
            message: "이메일 인증 중 오류가 발생했습니다.",
          });
      });
    return () => {
      current = false;
    };
  }, [token]);

  // A missing token is knowable from the URL, so it is derived rather than
  // pushed into state by an effect.
  const resolved: Outcome | null = token
    ? outcome
    : { status: "error", message: "유효하지 않은 인증 링크입니다." };
  const status = resolved?.status ?? "loading";
  const message = resolved?.message ?? "";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="max-w-md w-full p-6">
        <div className="bg-card border-2 border-line rounded-lg p-8">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-foreground mb-2">
              이메일 인증
            </h1>
          </div>

          {status === "loading" && (
            <div className="text-center">
              <Loader className="h-12 w-12 animate-spin text-primary mx-auto mb-4" />
              <p className="text-muted-foreground">인증 중입니다...</p>
            </div>
          )}

          {status === "success" && (
            <div className="text-center">
              <CheckCircle className="h-16 w-16 text-success mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-success mb-2">
                인증 완료
              </h2>
              <p className="text-success mb-6">
                {message}
              </p>
              <Button asChild className="w-full">
                {next === "/supporter" ? (
                  <a href="/supporter">결제 계속하기</a>
                ) : (
                  <a href="/account">계정 관리로 이동</a>
                )}
              </Button>
            </div>
          )}

          {status === "error" && (
            <div className="text-center">
              <XCircle className="h-16 w-16 text-destructive mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-destructive mb-2">
                인증 실패
              </h2>
              <p className="text-destructive mb-6">{message}</p>
              <Button variant="outline" asChild className="w-full">
                <a href="/account">계정 관리로 이동</a>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
