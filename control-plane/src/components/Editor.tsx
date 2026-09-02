"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import MonacoEditor, { DiffEditor } from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { EDITABLE_FILE_EXTENSION_MAP } from "@/lib/const";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export default function Editor({
  filename,
  contents,
  showSaveButton = true,
  showDiff: showDiffProp = false,
  onlyShowSaveButton = false,
  value: externalValue,
  onChange: externalOnChange,
}: {
  filename: string;
  contents: string;
  showSaveButton?: boolean;
  showDiff?: boolean;
  onlyShowSaveButton?: boolean;
  value?: string;
  onChange?: (value: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const [internalValue, setInternalValue] = useState(contents);
  const [internalShowDiff, setInternalShowDiff] = useState(false);
  const showDiff = showDiffProp || internalShowDiff;
  const value = externalValue !== undefined ? externalValue : internalValue;
  const setValue = externalOnChange || setInternalValue;
  const onChange = useCallback(
    (val: string | undefined) => {
      setValue(val ?? "");
    },
    [setValue],
  );

  const diffEditorRef = useRef<any>(null);

  useEffect(() => {
    // Monaco's _doFindMatchesMultiline doesn't catch invalid regex errors (monaco-editor bug).
    // Suppress them here so they don't surface as unhandled errors.
    const handleError = (event: ErrorEvent) => {
      if (
        event.message.startsWith("Invalid regular expression:") &&
        event.error?.stack?.includes("monaco-editor")
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("error", handleError);
    return () => {
      window.removeEventListener("error", handleError);
      diffEditorRef.current?.dispose();
      diffEditorRef.current = null;
    };
  }, []);

  const isDark = resolvedTheme === "dark";
  const ext = filename.split(".").pop() as string;
  const language = EDITABLE_FILE_EXTENSION_MAP[ext] ?? "plaintext";
  const theme = isDark ? "vs-dark" : "light";
  const hasChanges = value !== contents;

  const handleSave = async () => {
    try {
      const response = await fetch("/api/files/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ filename, contents: value }),
      });

      const res = await response.json();
      if (res.success) {
        toast.success(`${res.message}: ${filename}`);
      } else {
        toast.error(`저장 실패: ${res.message}`);
      }
    } catch (error) {
      toast.error(`파일 저장에 실패했습니다: ${filename}`);
    }
  };

  if (onlyShowSaveButton) {
    return (
      <Button
        type="button"
        value="저장"
        onClick={handleSave}
        className="w-full"
      >
        저장
      </Button>
    );
  }

  return (
    <div className={`flex flex-col h-full ${showSaveButton ? "gap-4" : ""}`}>
      <div className="flex-1 min-h-0">
        {showDiff ? (
          <DiffEditor
            original={contents}
            modified={value}
            language={language}
            theme={theme}
            height="100%"
            onMount={(diffEditor) => {
              diffEditorRef.current = diffEditor;
              const modifiedEditor = diffEditor.getModifiedEditor();
              modifiedEditor.onDidChangeModelContent(() => {
                onChange(modifiedEditor.getValue());
              });
            }}
            options={{
              minimap: { enabled: true },
              lineNumbers: "on",
              folding: true,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              renderSideBySide: true,
              readOnly: true,
            }}
          />
        ) : (
          <MonacoEditor
            value={value}
            height="100%"
            language={language}
            theme={theme}
            onChange={onChange}
            options={{
              minimap: { enabled: true },
              lineNumbers: "on",
              folding: true,
              wordWrap: "on",
              scrollBeyondLastLine: false,
            }}
          />
        )}
      </div>
      {showSaveButton && (
        <div className="flex gap-2">
          {hasChanges && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setInternalShowDiff((v) => !v)}
            >
              {showDiff ? "편집" : "변경 사항"}
            </Button>
          )}
          <Button type="button" value="저장" onClick={handleSave}>
            저장
          </Button>
        </div>
      )}
    </div>
  );
}
