"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle, XCircle, AlertTriangle } from "lucide-react";

type Outcome = { status: "success" | "error"; message: string };

export default function ConfirmAccountDeletionPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [password, setPassword] = useState("");

  // A missing token is knowable from the URL, so it needs no state.
  const { status, message } = token
    ? (outcome ?? { status: "loading", message: "" })
    : { status: "error", message: "유효하지 않은 계정 삭제 링크입니다." };

  const handleConfirmDeletion = async () => {
    if (!token) return;

    setIsProcessing(true);
    try {
      const response = await fetch("/api/account/confirm-account-deletion", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token, password }),
      });

      const result = await response.json();
      if (result.success) {
        setOutcome({ status: "success", message: result.message });
        // Redirect to home page after successful deletion
        setTimeout(() => {
          window.location.href = "/";
        }, 3000);
      } else {
        setOutcome({ status: "error", message: result.message });
      }
    } catch (error) {
      setOutcome({
        status: "error",
        message: "계정 삭제 중 오류가 발생했습니다.",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="max-w-md w-full p-6">
        <div className="bg-card border-2 border-line rounded-lg p-8">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-foreground mb-2">
              계정 삭제 확인
            </h1>
          </div>
          {status === "loading" && token && (
            <div className="space-y-6">
              <div className="text-center">
                <p className="text-muted-foreground">
                  계정을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.
                </p>
                <div className="mt-4 p-4 bg-destructive/10 border border-destructive">
                  <div className="flex">
                    <div className="flex-shrink-0">
                      <AlertTriangle className="h-5 w-5 text-destructive" />
                    </div>
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-destructive">
                        삭제될 데이터
                      </h3>
                      <div className="mt-2 text-sm text-destructive">
                        <ul className="list-disc pl-5 space-y-1">
                          <li>모든 파일과 웹사이트 데이터</li>
                          <li>계정 정보 및 설정</li>
                          <li>이메일 인증 정보</li>
                          <li>모든 세션 데이터</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  비밀번호 확인
                </label>
                <Input
                  type="password"
                  placeholder="비밀번호를 입력해주세요"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleConfirmDeletion();
                  }}
                  disabled={isProcessing}
                />
              </div>
              <div className="flex space-x-4">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => window.location.href = "/account"}
                  disabled={isProcessing}
                >
                  취소
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  onClick={handleConfirmDeletion}
                  disabled={isProcessing || !password}
                >
                  {isProcessing ? "삭제 중..." : "계정 삭제"}
                </Button>
              </div>
            </div>
          )}

          {status === "success" && (
            <div className="text-center space-y-4">
              <CheckCircle className="h-16 w-16 text-success mx-auto" />
              <h2 className="text-xl font-semibold text-success">
                계정 삭제 완료
              </h2>
              <p className="text-success">{message}</p>
              <p className="text-sm text-muted-foreground">3초 후 홈페이지로 이동합니다...</p>
            </div>
          )}

          {status === "error" && (
            <div className="text-center space-y-4">
              <XCircle className="h-16 w-16 text-destructive mx-auto" />
              <h2 className="text-xl font-semibold text-destructive">
                오류 발생
              </h2>
              <p className="text-destructive">{message}</p>
              <Button
                variant="outline"
                onClick={() => window.location.href = "/account"}
                className="w-full"
              >
                계정 페이지로 돌아가기
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}