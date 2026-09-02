"use client";

import {
  useState,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
  useRef,
} from "react";
import {
  EDITABLE_FILE_EXTENSIONS,
  IMAGE_FILE_EXTENSIONS,
  AUDIO_FILE_EXTENSIONS,
} from "@/lib/const";
import { getPublicAssetUrl } from "@/lib/utils";
import Editor from "@/components/Editor";
import ImageViewer, { ImageViewerRef } from "./ImageViewer";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { format as prettierFormat } from "prettier/standalone";
import prettierPluginHtml from "prettier/plugins/html";
import prettierPluginCss from "prettier/plugins/postcss";
import prettierPluginBabel from "prettier/plugins/babel";
import prettierPluginEstree from "prettier/plugins/estree";
import prettierPluginMarkdown from "prettier/plugins/markdown";

export type FileType = "editable" | "image" | "audio" | "other";

export interface FileViewerRef {
  fileType: FileType;
  save: () => Promise<void>;
  format: () => Promise<void>;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  getZoom: () => number;
  toggleDiff: () => void;
  getShowDiff: () => boolean;
  getHasChanges: () => boolean;
}

interface FileViewerProps {
  filePath: string;
  userLoginName: string;
  showDiff?: boolean;
  onSave?: () => void;
}

const PRETTIER_PARSER_MAP: Record<
  string,
  { parser: string; plugins: any[] } | null
> = {
  html: { parser: "html", plugins: [prettierPluginHtml] },
  htm: { parser: "html", plugins: [prettierPluginHtml] },
  xhtml: { parser: "html", plugins: [prettierPluginHtml] },
  xml: { parser: "html", plugins: [prettierPluginHtml] },
  svg: { parser: "html", plugins: [prettierPluginHtml] },
  css: { parser: "css", plugins: [prettierPluginCss] },
  js: { parser: "babel", plugins: [prettierPluginBabel, prettierPluginEstree] },
  json: {
    parser: "json",
    plugins: [prettierPluginBabel, prettierPluginEstree],
  },
  md: { parser: "markdown", plugins: [prettierPluginMarkdown] },
  markdown: { parser: "markdown", plugins: [prettierPluginMarkdown] },
  mdx: { parser: "mdx", plugins: [prettierPluginMarkdown] },
};

const FileViewer = forwardRef<FileViewerRef, FileViewerProps>(
  function FileViewer(
    { filePath, userLoginName, showDiff: showDiffProp = false, onSave },
    ref,
  ) {
    const [fileContent, setFileContent] = useState<string>("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editorValue, setEditorValue] = useState<string>("");
    const imageViewerRef = useRef<ImageViewerRef>(null);

    const fileName = filePath.split("/").pop() || "";
    const fileExtension = fileName.split(".").pop()?.toLowerCase() || "";

    const isEditable = EDITABLE_FILE_EXTENSIONS.includes(fileExtension);
    const isImage = IMAGE_FILE_EXTENSIONS.includes(fileExtension);
    const isAudio = AUDIO_FILE_EXTENSIONS.includes(fileExtension);

    const fetchFileContent = useCallback(async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/files/content?path=${encodeURIComponent(filePath)}`,
        );
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("파일을 찾을 수 없습니다");
          }
          throw new Error(`파일을 불러올 수 없습니다: ${response.statusText}`);
        }
        const content = await response.text();
        setFileContent(content);
        setEditorValue(content);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다",
        );
      } finally {
        setLoading(false);
      }
    }, [filePath]);

    useEffect(() => {
      if (isEditable) {
        fetchFileContent();
      } else {
        setLoading(false);
      }
    }, [isEditable, fetchFileContent]);

    const handleSave = useCallback(async () => {
      try {
        const response = await fetch("/api/files/save", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ filename: filePath, contents: editorValue }),
        });

        const res = await response.json();
        if (res.success) {
          toast.success(`${res.message}: ${filePath}`);
          setFileContent(editorValue);
          onSave?.();
        } else {
          toast.error(`저장 실패: ${res.message}`);
        }
      } catch (error) {
        toast.error(`파일 저장에 실패했습니다: ${filePath}`);
      }
    }, [filePath, editorValue, onSave]);

    const handleFormat = useCallback(async () => {
      const config = PRETTIER_PARSER_MAP[fileExtension];
      if (!config) {
        toast.error("이 파일 형식은 포맷을 지원하지 않습니다");
        return;
      }
      try {
        const formatted = await prettierFormat(editorValue, {
          parser: config.parser,
          plugins: config.plugins,
        });
        setEditorValue(formatted);
      } catch (e) {
        toast.error(
          `포맷 실패: ${e instanceof Error ? e.message : "알 수 없는 오류"}`,
        );
      }
    }, [editorValue, fileExtension]);

    const fileType: FileType = isEditable
      ? "editable"
      : isImage
        ? "image"
        : isAudio
          ? "audio"
          : "other";

    useImperativeHandle(
      ref,
      () => ({
        fileType,
        save: handleSave,
        format: handleFormat,
        zoomIn: () => imageViewerRef.current?.zoomIn(),
        zoomOut: () => imageViewerRef.current?.zoomOut(),
        resetZoom: () => imageViewerRef.current?.resetZoom(),
        getZoom: () => imageViewerRef.current?.getZoom() ?? 1,
        toggleDiff: () => {},
        getShowDiff: () => showDiffProp,
        getHasChanges: () => editorValue !== fileContent,
      }),
      [
        editorValue,
        fileContent,
        fileType,
        handleFormat,
        handleSave,
        showDiffProp,
      ],
    );

    if (loading) {
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <div className="text-4xl mb-4">⏳</div>
            <p className="text-muted-foreground">파일을 불러오는 중...</p>
          </div>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <div className="text-4xl mb-4">❌</div>
            <p className="text-red-600 mb-2">파일을 불러올 수 없습니다</p>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        </div>
      );
    }

    // Handle different file types
    if (isEditable) {
      return (
        <div className="h-full overflow-auto">
          <Editor
            filename={filePath}
            contents={fileContent}
            showSaveButton={false}
            showDiff={showDiffProp}
            value={editorValue}
            onChange={setEditorValue}
          />
        </div>
      );
    }

    if (isImage) {
      const imageSrc = getPublicAssetUrl(userLoginName, filePath);
      return (
        <ImageViewer
          ref={imageViewerRef}
          src={imageSrc}
          alt={fileName}
          filename={fileName}
        />
      );
    }

    if (isAudio) {
      const audioSrc = getPublicAssetUrl(userLoginName, filePath);
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center max-w-md">
            <div className="text-6xl mb-4">🎵</div>
            <h3 className="text-lg font-medium text-foreground mb-4">
              {fileName}
            </h3>
            <audio controls className="w-full mb-4" src={audioSrc}>
              Your browser does not support the audio element.
            </audio>
            <Button variant="outline" asChild>
              <a href={audioSrc} target="_blank" rel="noopener noreferrer">
                다운로드
              </a>
            </Button>
          </div>
        </div>
      );
    }

    // For other file types, show download option
    const fileUrl = getPublicAssetUrl(userLoginName, filePath);
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="text-6xl mb-4">📄</div>
          <h3 className="text-lg font-medium text-foreground mb-2">
            {fileName}
          </h3>
          <p className="text-muted-foreground mb-4">
            이 파일 형식은 미리보기를 지원하지 않습니다
          </p>
          <div className="space-y-2">
            <Button variant="outline" asChild>
              <a href={fileUrl} target="_blank" rel="noopener noreferrer">
                새 탭에서 열기
              </a>
            </Button>
            <br />
            <Button variant="outline" asChild>
              <a href={fileUrl} download>
                다운로드
              </a>
            </Button>
          </div>
        </div>
      </div>
    );
  },
);

export default FileViewer;
