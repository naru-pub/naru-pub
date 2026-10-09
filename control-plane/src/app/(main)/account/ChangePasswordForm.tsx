"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Lock, Key } from "lucide-react";
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

const formSchema = z
  .object({
    originalPassword: z.string().min(8, {
      message: "비밀번호는 8자 이상이어야 합니다.",
    }),
    newPassword: z.string().min(8, {
      message: "비밀번호는 8자 이상이어야 합니다.",
    }),
    newPasswordConfirm: z.string().min(8, {
      message: "비밀번호는 8자 이상이어야 합니다.",
    }),
  })
  .refine((data) => data.newPassword === data.newPasswordConfirm, {
    message: "비밀번호가 일치하지 않습니다.",
    path: ["passwordConfirm"],
  });

export default function ChangePasswordForm() {
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      originalPassword: "",
      newPassword: "",
      newPasswordConfirm: "",
    },
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    try {
      const response = await fetch("/api/account/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          originalPassword: values.originalPassword,
          newPassword: values.newPassword,
        }),
      });

      const res = await response.json();
      if (res.success) {
        toast.success(res.message);
        form.reset();
      } else {
        toast.error(res.message);
      }
    } catch (error) {
      toast.error("비밀번호 변경 중 오류가 발생했습니다.");
    }
  }

  return (
    <Card className="bg-card border-2 border-line">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <Lock size={20} />
          비밀번호 변경
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6">
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="originalPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-foreground">기존 비밀번호</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription className="text-muted-foreground">
                    비밀번호는 8자 이상이어야 합니다.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="newPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-foreground">새 비밀번호</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormDescription className="text-muted-foreground">
                    비밀번호는 8자 이상이어야 합니다.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="newPasswordConfirm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-foreground">비밀번호 확인</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormDescription className="text-muted-foreground">
                    새 비밀번호를 한 번 더 입력해주세요.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" className="flex items-center gap-2">
              <Key size={16} />
              비밀번호 변경
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
