"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";

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
import { useState } from "react";

const formSchema = z.object({
  email: z.string().email({
    message: "올바른 이메일 주소를 입력해주세요.",
  }),
});

export default function ForgotPasswordPage() {
  const [isSubmitted, setIsSubmitted] = useState(false);
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
    },
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    try {
      const response = await fetch("/api/account/request-password-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: values.email,
        }),
      });

      const res = await response.json();
      if (res.success) {
        setIsSubmitted(true);
      } else {
        form.setError("email", {
          type: "manual",
          message: res.message,
        });
      }
    } catch (error) {
      form.setError("email", {
        type: "manual",
        message: "요청 처리 중 오류가 발생했습니다.",
      });
    }
  }

  if (isSubmitted) {
    return (
      <div className="max-w-md mx-auto p-6">
        <div className="bg-card border-2 border-line p-6 text-center">
          <h1 className="text-2xl font-bold text-foreground mb-4">이메일을 확인해주세요</h1>
          <p className="text-muted-foreground mb-4">
            비밀번호 재설정 링크가 입력하신 이메일로 발송되었습니다.
            이메일을 확인하여 비밀번호를 재설정해주세요.
          </p>
          <p className="text-sm text-muted-foreground">
            이메일이 도착하지 않았다면 스팸 폴더를 확인해주세요.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto p-6">
      <div className="bg-card border-2 border-line p-6">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-foreground mb-2">비밀번호 찾기</h1>
          <p className="text-muted-foreground">등록하신 이메일 주소를 입력해주세요</p>
        </div>
        
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-foreground font-medium">이메일 주소</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="example@email.com"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription className="text-muted-foreground text-sm">
                    계정에 연결된 인증된 이메일 주소를 입력해주세요.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button 
              type="submit" 
              className="w-full font-medium"
            >
              비밀번호 재설정 링크 보내기
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}