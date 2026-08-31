"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useFileUpload } from "./useFileUpload";
import UploadStatus from "./UploadStatus";
import DirectoryTree from "./DirectoryTree";
import FileViewer, { FileViewerRef } from "./FileViewer";
import { FileNode } from "@/lib/fileUtils";
import { Button } from "@/components/ui/button";
import { EDITABLE_FILE_EXTENSIONS, IMAGE_FILE_EXTENSIONS } from "@/lib/const";

interface FileExplorerWithSelectedProps {
  initialFiles: FileNode[];
  userLoginName: string;
  initialSelectedFile: string | null;
}

export default function FileExplorerWithSelected({ 
  initialFiles, 
  userLoginName, 
  initialSelectedFile 
}: FileExplorerWithSelectedProps) {
  const [files, setFiles] = useState<FileNode[]>(initialFiles);
  const [selectedFile, setSelectedFile] = useState<string | null>(initialSelectedFile);
  const [showDiff, setShowDiff] = useState(false);
  const fileViewerRef = useRef<FileViewerRef>(null);

  // Build expanded folders set based on the initially selected file
  const buildInitialExpandedFolders = (selectedFilePath: string | null): Set<string> => {
    const expanded = new Set<string>([""]); // Always expand root
    
    if (selectedFilePath) {
      const parts = selectedFilePath.split('/');
      let currentPath = "";
      
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
        expanded.add(currentPath);
      }
    }
    
    return expanded;
  };

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    buildInitialExpandedFolders(initialSelectedFile)
  );
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
    if (!isDirectory) {
      setSelectedFile(filePath);
      setShowDiff(false);
      // Update URL without page reload
      const newUrl = `/files/edit/${filePath}`;
      window.history.pushState({}, '', newUrl);
    }
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

  const { uploading, progress, upload } = useFileUpload(handleRefresh);

  return (
    <div className="flex h-full bg-card overflow-hidden">
      {/* Left Sidebar - Directory Tree */}
      <div className="bg-muted overflow-auto shrink-0" style={{ width: sidebarWidth }}>
        <div className="h-12 flex items-center px-3 border-b border-border bg-secondary">
          <h3 className="font-medium text-foreground">📁 파일 탐색기</h3>
        </div>
        <DirectoryTree
          files={files}
          selectedFile={selectedFile}
          expandedFolders={expandedFolders}
          onFileSelect={handleFileSelect}
          onFolderToggle={handleFolderToggle}
          onRefresh={handleRefresh}
          uploading={uploading}
          onUpload={upload}
        />
        {progress && <div className="p-3"><UploadStatus progress={progress} /></div>}
      </div>

      {/* Resize Handle */}
      <div
        className="w-1 cursor-col-resize bg-border hover:bg-primary/40 active:bg-primary/60 transition-colors shrink-0"
        onMouseDown={handleResizeMouseDown}
      />

      {/* Right Main Area - File Viewer */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="shrink-0 h-12 px-3 border-b border-border bg-secondary flex items-center justify-between">
          <h3 className="font-medium text-foreground">
            {selectedFile ? `📄 ${selectedFile.split('/').pop()}` : "파일을 선택하세요"}
          </h3>
          {selectedFile && (() => {
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
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {selectedFile ? (
            <FileViewer key={selectedFile} ref={fileViewerRef} filePath={selectedFile} userLoginName={userLoginName} showDiff={showDiff} onSave={() => setShowDiff(false)} />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <div className="text-6xl mb-4">📂</div>
                <p>왼쪽에서 파일을 선택하여 내용을 확인하세요</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}