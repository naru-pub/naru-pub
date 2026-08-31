"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import UploadStatus from "./UploadStatus";
import { useFileUpload } from "./useFileUpload";
import DirectoryTree from "./DirectoryTree";
import FileViewer, { FileViewerRef } from "./FileViewer";
import { FileNode } from "@/lib/fileUtils";
import { EDITABLE_FILE_EXTENSIONS, IMAGE_FILE_EXTENSIONS, AUDIO_FILE_EXTENSIONS } from "@/lib/const";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Folder,
  FolderOpen,
  Globe,
  Palette,
  FileCode,
  Braces,
  FileText,
  Image as ImageIcon,
  Music,
  File as FileIcon,
  Upload,
  ArrowUpToLine,
} from "lucide-react";

interface FileExplorerProps {
  initialFiles: FileNode[];
  userLoginName: string;
}

function getFileIcon(fileName: string, isDirectory: boolean): React.ReactNode {
  const cls = "inline-block align-middle shrink-0";
  const size = 16;
  if (isDirectory) return <Folder size={size} className={cls} />;

  const extension = fileName.split('.').pop()?.toLowerCase() || "";

  if (EDITABLE_FILE_EXTENSIONS.includes(extension)) {
    switch (extension) {
      case "html":
      case "htm":
        return <Globe size={size} className={cls} />;
      case "css":
        return <Palette size={size} className={cls} />;
      case "js":
        return <FileCode size={size} className={cls} />;
      case "json":
        return <Braces size={size} className={cls} />;
      case "md":
      case "markdown":
        return <FileText size={size} className={cls} />;
      default:
        return <FileIcon size={size} className={cls} />;
    }
  }

  if (IMAGE_FILE_EXTENSIONS.includes(extension)) {
    return <ImageIcon size={size} className={cls} />;
  }

  if (AUDIO_FILE_EXTENSIONS.includes(extension)) {
    return <Music size={size} className={cls} />;
  }

  return <FileIcon size={size} className={cls} />;
}

export default function FileExplorer({ initialFiles, userLoginName }: FileExplorerProps) {
  const [files, setFiles] = useState<FileNode[]>(initialFiles);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set([""]));
  const [isDragOver, setIsDragOver] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const dragCounterRef = useRef(0);
  const fileViewerRef = useRef<FileViewerRef>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const isResizing = useRef(false);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.min(Math.max(e.clientX, 200), 600);
      setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (!isResizing.current) return;
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const handleFileSelect = (filePath: string, isDirectory: boolean) => {
    if (isDirectory) {
      // When a directory is clicked, set it as the current working directory
      setSelectedFile(filePath);
    } else {
      // For files, set as selected file
      setSelectedFile(filePath);
    }
    setShowDiff(false);
  };

  const handleFolderToggle = (folderPath: string) => {
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(folderPath)) {
      newExpanded.delete(folderPath);
    } else {
      newExpanded.add(folderPath);
    }
    setExpandedFolders(newExpanded);
  };

  const handleRefresh = async () => {
    try {
      const response = await fetch("/api/files/tree");
      const result = await response.json();

      if (result.success) {
        setFiles(result.files);
      } else {
        console.error("Failed to refresh files:", result.message);
      }
    } catch (error) {
      console.error("Failed to refresh files:", error);
    }
  };

  const getCurrentDirectory = () => {
    if (!selectedFile) return "";

    const findNode = (nodes: FileNode[], path: string): FileNode | null => {
      for (const node of nodes) {
        if (node.path === path) return node;
        if (node.children) {
          const found = findNode(node.children, path);
          if (found) return found;
        }
      }
      return null;
    };

    const selectedNode = findNode(files, selectedFile);
    if (selectedNode?.isDirectory) {
      return selectedFile;
    } else {
      const parts = selectedFile.split('/');
      parts.pop();
      return parts.join('/');
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;

    if (e.dataTransfer.types.includes("Files")) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;

    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCounterRef.current = 0;
    setIsDragOver(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length === 0) return;

    await handleUpload(droppedFiles, getCurrentDirectory());
  };

  const { uploading, progress: uploadProgress, upload: handleUpload } = useFileUpload(handleRefresh);

  const handleStartRename = () => {
    if (!selectedFile) return;

    // Check if selected item is a file (not directory)
    const findNode = (nodes: FileNode[], path: string): FileNode | null => {
      for (const node of nodes) {
        if (node.path === path) return node;
        if (node.children) {
          const found = findNode(node.children, path);
          if (found) return found;
        }
      }
      return null;
    };

    const selectedNode = findNode(files, selectedFile);
    if (selectedNode?.isDirectory) {
      return; // Don't allow renaming directories for now
    }

    const filename = selectedFile.split('/').pop() || "";
    // Extract filename without extension for editing
    const lastDotIndex = filename.lastIndexOf('.');
    const filenameWithoutExt = lastDotIndex > 0 ? filename.substring(0, lastDotIndex) : filename;

    setNewFileName(filenameWithoutExt);
    setIsRenaming(true);
  };

  const handleCancelRename = () => {
    setIsRenaming(false);
    setNewFileName("");
  };

  const handleConfirmRename = async () => {
    if (!selectedFile || !newFileName.trim()) {
      handleCancelRename();
      return;
    }

    try {
      const originalFilename = selectedFile.split('/').pop() || "";
      const lastDotIndex = originalFilename.lastIndexOf('.');
      const extension = lastDotIndex > 0 ? originalFilename.substring(lastDotIndex) : "";

      // Combine new filename with original extension
      const finalFilename = newFileName.trim() + extension;

      // Check if the new filename is the same as the original
      if (finalFilename === originalFilename) {
        handleCancelRename();
        return;
      }

      // Check if a file with the new name already exists
      const pathParts = selectedFile.split('/');
      pathParts[pathParts.length - 1] = finalFilename;
      const newPath = pathParts.join('/');

      const checkExisting = (nodes: FileNode[], targetPath: string): boolean => {
        for (const node of nodes) {
          if (node.path === targetPath) {
            return true;
          }
          if (node.children) {
            if (checkExisting(node.children, targetPath)) {
              return true;
            }
          }
        }
        return false;
      };

      if (checkExisting(files, newPath)) {
        const confirmOverwrite = confirm(
          `"${finalFilename}" 파일이 이미 존재합니다.\n기존 파일을 덮어쓰시겠습니까?`
        );
        if (!confirmOverwrite) {
          return; // Don't proceed with rename
        }
      }

      const response = await fetch("/api/files/rename", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          oldFilename: selectedFile,
          newFilename: finalFilename,
        }),
      });

      const result = await response.json();

      if (result.success) {
        // Update selected file to new path
        setSelectedFile(newPath);
        await handleRefresh();
        handleCancelRename();
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error("Rename error:", error);
      toast.error("파일 이름 변경에 실패했습니다.");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleConfirmRename();
    } else if (e.key === "Escape") {
      handleCancelRename();
    }
  };

  return (
    <div
      className="flex h-full bg-card overflow-hidden relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Left Sidebar - Directory Tree */}
      <div className="bg-muted overflow-auto shrink-0" style={{ width: sidebarWidth }}>
        <div className="h-12 flex items-center px-3 border-b border-border bg-secondary">
          <h3 className="font-medium text-foreground truncate">
            <span className="text-muted-foreground select-none">~/</span>
            {userLoginName}
          </h3>
        </div>
        <DirectoryTree
          files={files}
          selectedFile={selectedFile}
          expandedFolders={expandedFolders}
          onFileSelect={handleFileSelect}
          onFolderToggle={handleFolderToggle}
          onRefresh={handleRefresh}
          uploading={uploading}
          onUpload={handleUpload}
        />
      </div>

      {/* Resize Handle */}
      <div
        className="w-1 cursor-col-resize bg-border hover:bg-primary/40 active:bg-primary/60 transition-colors shrink-0"
        onMouseDown={handleResizeMouseDown}
      />

      {/* Right Main Area - File Viewer */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="shrink-0 h-12 flex items-center px-3 border-b border-border bg-secondary">
          {selectedFile ? (
            <div className="flex items-center justify-between w-full">
              {isRenaming ? (
                <div className="flex items-center space-x-2 flex-1">
                  <span>{getFileIcon(selectedFile.split('/').pop() || "", false)}</span>
                  <div className="flex items-center">
                    <input
                      type="text"
                      value={newFileName}
                      onChange={(e) => setNewFileName(e.target.value)}
                      onKeyDown={handleKeyDown}
                      className="px-2 py-1 text-sm border border-primary rounded-l focus:outline-none focus:ring-2 focus:ring-primary"
                      autoFocus
                    />
                    {(() => {
                      const originalFilename = selectedFile?.split('/').pop() || "";
                      const lastDotIndex = originalFilename.lastIndexOf('.');
                      const extension = lastDotIndex > 0 ? originalFilename.substring(lastDotIndex) : "";
                      return extension ? (
                        <span className="px-2 py-1 text-sm bg-secondary border border-l-0 border-r-0 border-primary text-muted-foreground">
                          {extension}
                        </span>
                      ) : null;
                    })()}
                    <button
                      onClick={handleConfirmRename}
                      className="px-2 py-1 text-xs bg-green-100 text-green-700 border border-green-300 hover:bg-green-200 hover:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-50 transition-colors"
                      title="저장 (Enter)"
                    >
                      ✓
                    </button>
                    <button
                      onClick={handleCancelRename}
                      className="px-2 py-1 text-xs bg-red-100 text-red-700 border border-red-300 rounded-r hover:bg-red-200 hover:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50 transition-colors"
                      title="취소 (Esc)"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center space-x-2 flex-1">
                    {(() => {
                      // Check if selected item is a directory
                      const findNode = (nodes: FileNode[], path: string): FileNode | null => {
                        for (const node of nodes) {
                          if (node.path === path) return node;
                          if (node.children) {
                            const found = findNode(node.children, path);
                            if (found) return found;
                          }
                        }
                        return null;
                      };

                      const selectedNode = findNode(files, selectedFile);
                      const isDirectory = selectedNode?.isDirectory;

                      if (isDirectory) {
                        return (
                          <h3 className="font-medium text-foreground truncate">
                            {getFileIcon(selectedFile.split('/').pop() || "", true)} {selectedFile.split('/').pop() || "루트"} (작업 폴더)
                          </h3>
                        );
                      } else {
                        return (
                          <h3
                            className="font-medium text-foreground truncate cursor-pointer hover:text-primary transition-colors"
                            onClick={handleStartRename}
                            title="클릭하여 이름 변경"
                          >
                            {getFileIcon(selectedFile.split('/').pop() || "", false)} {selectedFile.split('/').pop()}
                          </h3>
                        );
                      }
                    })()}
                  </div>
                  {(() => {
                    const ext = selectedFile.split('.').pop()?.toLowerCase() || '';
                    if (EDITABLE_FILE_EXTENSIONS.includes(ext)) {
                      return (
                        <div className="flex items-center gap-2">
                          <Button variant="outline" size="sm" onClick={() => fileViewerRef.current?.format()}>
                            포맷
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => setShowDiff((v) => !v)}>
                            {showDiff ? "편집" : "변경 사항"}
                          </Button>
                          <Button size="sm" onClick={() => fileViewerRef.current?.save()}>
                            저장
                          </Button>
                        </div>
                      );
                    }
                    if (IMAGE_FILE_EXTENSIONS.includes(ext)) {
                      return (
                        <div className="flex items-center gap-2">
                          <Button variant="outline" size="sm" onClick={() => fileViewerRef.current?.zoomOut()}>축소</Button>
                          <Button variant="outline" size="sm" onClick={() => fileViewerRef.current?.resetZoom()}>원본</Button>
                          <Button variant="outline" size="sm" onClick={() => fileViewerRef.current?.zoomIn()}>확대</Button>
                        </div>
                      );
                    }
                    return null;
                  })()}
                </>
              )}
            </div>
          ) : (
            <h3 className="font-medium text-foreground">파일을 선택하세요</h3>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {selectedFile ? (
            (() => {
              // Check if selected item is a directory
              const findNode = (nodes: FileNode[], path: string): FileNode | null => {
                for (const node of nodes) {
                  if (node.path === path) return node;
                  if (node.children) {
                    const found = findNode(node.children, path);
                    if (found) return found;
                  }
                }
                return null;
              };

              const selectedNode = findNode(files, selectedFile);

              if (selectedNode?.isDirectory) {
                return (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    <div className="text-center">
                      <FolderOpen size={60} className="mx-auto mb-4" strokeWidth={1.25} />
                      <p className="text-lg font-medium mb-2">현재 작업 폴더: {selectedFile || "루트"}</p>
                      <p>이 폴더에서 파일을 생성하거나 업로드할 수 있습니다</p>
                    </div>
                  </div>
                );
              } else {
                return <FileViewer key={selectedFile} ref={fileViewerRef} filePath={selectedFile} userLoginName={userLoginName} showDiff={showDiff} onSave={() => setShowDiff(false)} />;
              }
            })()
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <FolderOpen size={60} className="mx-auto mb-4" strokeWidth={1.25} />
                <p>왼쪽에서 파일을 선택하여 내용을 확인하세요</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Drag and Drop Overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-card p-6 rounded-lg border-2 border-border shadow-lg text-center border-4 border-dashed border-primary">
            <Upload size={60} className="mx-auto mb-4 text-primary" strokeWidth={1.25} />
            <p className="text-xl font-semibold text-primary">파일을 여기에 드롭하세요</p>
            <p className="text-sm mt-2 text-muted-foreground">
              {getCurrentDirectory() || "루트 폴더"}에 업로드됩니다
            </p>
          </div>
        </div>
      )}

      {/* Upload Progress Overlay */}
      {uploading && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-card p-6 rounded-lg border-2 border-border shadow-lg text-center">
            <ArrowUpToLine size={28} className="mx-auto mb-2" />
            {uploadProgress && <UploadStatus progress={uploadProgress} />}
          </div>
        </div>
      )}
    </div>
  );
}
