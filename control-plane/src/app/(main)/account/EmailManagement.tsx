"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Mail, CheckCircle, Clock, Loader, Send } from "lucide-react";

const emailSchema = z.object({
  email: z.string().email("유효한 이메일 주소를 입력해주세요."),
});

type EmailFormData = z.infer<typeof emailSchema>;

interface EmailManagementProps {
  currentEmail: string | null;
  emailVerifiedAt: Date | null;
}

export default function EmailManagement({ currentEmail, emailVerifiedAt }: EmailManagementProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);

  const form = useForm<EmailFormData>({
    resolver: zodResolver(emailSchema),
    defaultValues: {
      email: currentEmail || "",
    },
  });

  const onSubmit = async (data: EmailFormData) => {
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/account/associate-email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: data.email,
        }),
      });

      const result = await response.json();
      if (result.success) {
        toast.success(`이메일이 성공적으로 업데이트되었습니다: ${result.message}`);
      } else {
        toast.error(`오류가 발생했습니다: ${result.message}`);
      }
    } catch (error) {
      toast.error("오류가 발생했습니다: 이메일 업데이트 중 문제가 발생했습니다.");
    }
    setIsSubmitting(false);
  };

  const handleResendVerification = async () => {
    setIsResending(true);
    try {
      const response = await fetch("/api/account/resend-verification-email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const result = await response.json();
      if (result.success) {
        toast.success(`인증 이메일이 재발송되었습니다: ${result.message}`);
      } else {
        toast.error(`오류가 발생했습니다: ${result.message}`);
      }
    } catch (error) {
      toast.error("오류가 발생했습니다: 이메일 재발송 중 문제가 발생했습니다.");
    }
    setIsResending(false);
  };

  return (
    <Card className="bg-card border-2 border-line">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <Mail size={20} />
          이메일 관리
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        {currentEmail && (
          <div className="bg-muted border border-border rounded p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">현재 이메일</p>
                <p className="font-medium text-muted-foreground">{currentEmail}</p>
              </div>
              <div className="flex items-center gap-2">
                {emailVerifiedAt ? (
                  <div className="text-right">
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-medium bg-success/10 text-success">
                      <CheckCircle size={12} />
                      인증됨
                    </span>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(emailVerifiedAt).toLocaleDateString('ko-KR')}
                    </p>
                  </div>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-medium bg-warning/10 text-warning">
                      <Clock size={12} />
                      인증 대기
                    </span>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={handleResendVerification}
                      disabled={isResending}
                      className="h-auto gap-1 px-0 text-xs"
                    >
                      {isResending ? (
                        <>
                          <Loader size={12} className="animate-spin" />
                          발송 중...
                        </>
                      ) : (
                        <>
                          <Send size={12} />
                          재발송
                        </>
                      )}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-foreground">
                    {currentEmail ? "이메일 변경" : "이메일 추가"}
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="your@email.com"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription className="text-muted-foreground">
                    새 이메일 주소를 입력하면 인증 이메일이 발송됩니다.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button type="submit" disabled={isSubmitting} className="flex items-center gap-2">
              {isSubmitting ? (
                <>
                  <Loader size={16} className="animate-spin" />
                  처리 중...
                </>
              ) : (
                <>
                  <Mail size={16} />
                  {currentEmail ? "이메일 변경" : "이메일 추가"}
                </>
              )}
            </Button>
          </form>
        </Form>

        {!emailVerifiedAt && currentEmail && (
          <div className="bg-warning/10 border border-warning p-4">
            <p className="text-sm text-warning">
              이메일 인증이 완료되지 않았습니다. 이메일함을 확인해주세요.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}