"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// The interactive pieces of /design, which the server page cannot render.
// The labels wrap the items, so the twin copies on /design need no ids.
export function RadioDemo() {
  return (
    <RadioGroup defaultValue="new" aria-label="적용 방식">
      <label className="flex items-center gap-2 text-sm">
        <RadioGroupItem value="new" />새 폴더에 적용
      </label>
      <label className="flex items-center gap-2 text-sm">
        <RadioGroupItem value="root" />
        사이트 전체를 바꾸기
      </label>
    </RadioGroup>
  );
}

export function TabsDemo() {
  return (
    <Tabs defaultValue="all" className="w-full">
      <TabsList>
        <TabsTrigger value="all">전체</TabsTrigger>
        <TabsTrigger value="site">사이트 자랑</TabsTrigger>
        <TabsTrigger value="template">템플릿</TabsTrigger>
        <TabsTrigger value="question">질문</TabsTrigger>
      </TabsList>
      <TabsContent value="all" className="pt-3 text-sm text-muted-foreground">
        탭을 눌러 보세요.
      </TabsContent>
      <TabsContent value="site" className="pt-3 text-sm text-muted-foreground">
        사이트 자랑 글
      </TabsContent>
      <TabsContent
        value="template"
        className="pt-3 text-sm text-muted-foreground"
      >
        템플릿 글
      </TabsContent>
      <TabsContent
        value="question"
        className="pt-3 text-sm text-muted-foreground"
      >
        질문 글
      </TabsContent>
    </Tabs>
  );
}

export function DialogDemo() {
  const confirm = useConfirm();
  const [answer, setAnswer] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">대화상자 열기</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>새 폴더</DialogTitle>
            <DialogDescription>
              폴더 이름은 주소의 일부가 돼요.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="design-folder">이름</Label>
            <Input id="design-folder" placeholder="assets" />
          </div>
          <DialogFooter>
            <Button>만들기</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Button
        variant="destructive"
        onClick={async () => {
          const ok = await confirm({
            title: "index.html을 지울까요?",
            description: "지운 파일은 되살릴 수 없어요.",
            confirmText: "삭제",
            destructive: true,
          });
          setAnswer(ok ? "삭제를 골랐어요" : "취소했어요");
        }}
      >
        확인 받기
      </Button>
      {answer && (
        <span className="text-sm text-muted-foreground" role="status">
          {answer}
        </span>
      )}
    </div>
  );
}

export function ContextMenuDemo() {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="flex h-20 w-full max-w-xs items-center justify-center border-2 border-dashed border-muted-foreground text-sm text-muted-foreground">
        여기를 오른쪽 클릭
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>이름 바꾸기</ContextMenuItem>
        <ContextMenuItem>새 창에서 열기</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem destructive>삭제</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
