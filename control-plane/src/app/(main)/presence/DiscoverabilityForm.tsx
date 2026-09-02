"use client";

import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, Save } from "lucide-react";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "@/components/ui/form";
import { toast } from "sonner";

const FormSchema = z.object({
  discoverable: z.boolean().default(false).optional(),
});

export function DiscoverabilityForm({
  discoverable,
}: {
  discoverable: boolean;
}) {
  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      discoverable,
    },
  });

  async function onSubmit(data: z.infer<typeof FormSchema>) {
    try {
      const response = await fetch("/api/account/set-discoverable", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          discoverable: data.discoverable ?? false,
        }),
      });

      const res = await response.json();
      if (res.success) {
        toast.success(res.message);
      } else {
        toast.error(res.message);
      }
    } catch (error) {
      toast.error("설정 변경 중 오류가 발생했습니다.");
    }
  }

  return (
    <Card className="bg-card border-2 border-border shadow-lg">
      <CardHeader className="bg-secondary border-b-2 border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <Search size={20} />
          검색 및 발견 설정
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="discoverable"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start space-x-3 space-y-0 bg-muted border border-border rounded p-3">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel className="text-foreground">
                      검색 및 발견 허용
                    </FormLabel>
                    <FormDescription className="text-muted-foreground">
                      해당 설정을 활성화한 경우 나루 메인 홈페이지에 노출될 수
                      있습니다.
                    </FormDescription>
                  </div>
                </FormItem>
              )}
            />
            <Button type="submit" className="flex items-center gap-2">
              <Save size={16} />
              저장
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
