"use client";

import { useState, useRef } from "react";
import { EDITABLE_FILE_EXTENSIONS, IMAGE_FILE_EXTENSIONS, AUDIO_FILE_EXTENSIONS } from "@/lib/const";
import { FileNode } from "@/lib/fileUtils";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
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
  FolderPlus,
  FilePlus,
  Trash2,
} from "lucide-react";

interface DirectoryTreeProps {
  files: FileNode[];
  selectedFile: string | null;
  expandedFolders: Set<string>;
  onFileSelect: (filePath: string, isDirectory: boolean) => void;
  onFolderToggle: (folderPath: string) => void;
  onRefresh: () => void;
  uploading: boolean;
  onUpload: (files: File[], directory: string) => Promise<boolean>;
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

function TreeNode({
  node,
  level = 0,
  selectedFile,
  expandedFolders,
  onFileSelect,
  onFolderToggle,
  onDelete,
  flashingItems,
  onMoveFile,
  dragOverDirectory,
  onDragOverDirectoryChange
}: {
  node: FileNode;
  level?: number;
  selectedFile: string | null;
  expandedFolders: Set<string>;
  onFileSelect: (filePath: string, isDirectory: boolean) => void;
  onFolderToggle: (folderPath: string) => void;
  onDelete: (filePath: string) => void;
  flashingItems: Set<string>;
  onMoveFile: (sourcePath: string, targetDirectory: string) => void;
  dragOverDirectory: string | null;
  onDragOverDirectoryChange: (directory: string | null) => void;
}) {
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const isExpanded = expandedFolders.has(node.path);
  const isSelected = selectedFile === node.path;
  const isFlashing = flashingItems.has(node.path);
  const isDragOver = dragOverDirectory === node.path;
  const isInDragTargetSubtree = dragOverDirectory ? (node.path === dragOverDirectory || node.path.startsWith(dragOverDirectory + "/")) : false;
  
  const handleClick = () => {
    if (node.isDirectory) {
      onFolderToggle(node.path);
      onFileSelect(node.path, true);
    } else {
      onFileSelect(node.path, false);
    }
  };

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };

  const handleDelete = () => {
    if (node.isDirectory) {
      // For directories, show all files that will be deleted
      const getFilesInDirectory = (dirNode: FileNode): string[] => {
        const files: string[] = [];
        if (dirNode.children) {
          for (const child of dirNode.children) {
            if (child.isDirectory) {
              files.push(...getFilesInDirectory(child));
            } else {
              files.push(child.path);
            }
          }
        }
        return files;
      };

      const affectedFiles = getFilesInDirectory(node);
      const fileCount = affectedFiles.length;

      let confirmMessage = `정말로 폴더 "${node.name}"을(를) 삭제하시겠습니까?`;

      if (fileCount > 0) {
        confirmMessage += `\n\n이 작업으로 ${fileCount}개의 파일이 함께 삭제됩니다:`;
        const maxShowFiles = 10;
        const filesToShow = affectedFiles.slice(0, maxShowFiles);
        confirmMessage += `\n• ${filesToShow.join('\n• ')}`;

        if (fileCount > maxShowFiles) {
          confirmMessage += `\n... 그리고 ${fileCount - maxShowFiles}개 파일 더`;
        }
      } else {
        confirmMessage += '\n\n(빈 폴더입니다)';
      }

      if (confirm(confirmMessage)) {
        onDelete(node.path);
      }
    } else {
      // For files, simple confirmation
      if (confirm(`정말로 "${node.name}"을(를) 삭제하시겠습니까?`)) {
        onDelete(node.path);
      }
    }
    setShowContextMenu(false);
  };

  // Drag handlers
  const handleDragStart = (e: React.DragEvent) => {
    if (node.isDirectory) {
      e.preventDefault(); // Don't allow dragging directories
      return;
    }
    setIsDragging(true);
    e.dataTransfer.setData("text/plain", node.path);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  // Drop handlers (only for directories)
  const handleDragOver = (e: React.DragEvent) => {
    if (!node.isDirectory) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";

    // Set this directory as the current drag target
    if (dragOverDirectory !== node.path) {
      onDragOverDirectoryChange(node.path);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    if (!node.isDirectory) return;
    e.preventDefault();
    e.stopPropagation();

    // Set this directory as the current drag target
    onDragOverDirectoryChange(node.path);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!node.isDirectory) return;
    e.preventDefault();

    // Only clear if we're the current drag target and actually leaving
    if (dragOverDirectory === node.path) {
      const relatedTarget = e.relatedTarget as Element;
      if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
        onDragOverDirectoryChange(null);
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!node.isDirectory) return;
    e.preventDefault();
    e.stopPropagation();

    onDragOverDirectoryChange(null);

    const sourcePath = e.dataTransfer.getData("text/plain");
    if (sourcePath && sourcePath !== node.path) {
      // Don't allow moving into a subdirectory of itself
      if (sourcePath.startsWith(node.path + "/")) {
        toast.error("파일을 하위 디렉토리로 이동할 수 없습니다.");
        return;
      }
      onMoveFile(sourcePath, node.path);
    }
  };

  return (
    <div
      className={isInDragTargetSubtree && node.isDirectory ? "bg-blue-100/80 dark:bg-blue-900/40" : ""}
      onDragOver={node.isDirectory ? handleDragOver : undefined}
      onDragEnter={node.isDirectory ? handleDragEnter : undefined}
      onDragLeave={node.isDirectory ? handleDragLeave : undefined}
      onDrop={node.isDirectory ? handleDrop : undefined}
    >
      <div
        className={`flex items-center py-1 px-2 cursor-pointer hover:bg-accent text-sm transition-all duration-300 border-2 border-dashed ${
          isSelected ? "bg-primary/10 font-medium text-primary" : ""
        } ${isFlashing ? "bg-green-100 animate-pulse" : ""} ${
          isDragging ? "opacity-50" : ""
        } ${isDragOver && node.isDirectory ? "bg-primary/20 border-primary" : isInDragTargetSubtree && node.isDirectory ? "border-primary/50" : "border-transparent"}`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        draggable={!node.isDirectory}
        onClick={handleClick}
        onContextMenu={handleRightClick}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {node.isDirectory && (
          <span className="mr-1 text-xs">
            {isExpanded ? "▼" : "▶"}
          </span>
        )}
        <span className="mr-2">{getFileIcon(node.name, node.isDirectory)}</span>
        <span className="text-sm text-foreground truncate">{node.name}</span>
      </div>

      {/* Context Menu */}
      {showContextMenu && (
        <>
          <div 
            className="fixed inset-0 z-10" 
            onClick={() => setShowContextMenu(false)}
          />
          <div 
            className="fixed z-20 bg-card border-2 border-border rounded shadow-lg py-1"
            style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
          >
            <button
              className="flex items-center gap-2 w-full text-left px-3 py-1 text-sm hover:bg-accent text-destructive"
              onClick={handleDelete}
            >
              <Trash2 size={14} className="shrink-0" /> 삭제
            </button>
          </div>
        </>
      )}
      
      {node.isDirectory && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              level={level + 1}
              selectedFile={selectedFile}
              expandedFolders={expandedFolders}
              onFileSelect={onFileSelect}
              onFolderToggle={onFolderToggle}
              onDelete={onDelete}
              flashingItems={flashingItems}
              onMoveFile={onMoveFile}
              dragOverDirectory={dragOverDirectory}
              onDragOverDirectoryChange={onDragOverDirectoryChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function DirectoryTree({
  files,
  selectedFile,
  expandedFolders,
  onFileSelect,
  onFolderToggle,
  onRefresh,
  uploading,
  onUpload,
}: DirectoryTreeProps) {
  const [newDirectoryName, setNewDirectoryName] = useState("");
  const [newFileName, setNewFileName] = useState("");
  const [showNewDirectoryInput, setShowNewDirectoryInput] = useState(false);
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [flashingItems, setFlashingItems] = useState<Set<string>>(new Set());
  const [isRootDropZone, setIsRootDropZone] = useState(false);
  const [dragOverDirectory, setDragOverDirectory] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Get current directory based on selected file/folder
  const getCurrentDirectory = () => {
    if (!selectedFile) return "";
    
    // If selected item is a directory, use it as current directory
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
      // If selected item is a file, use its parent directory
      const parts = selectedFile.split('/');
      parts.pop(); // Remove file name
      return parts.join('/');
    }
  };

  const targetDirectory = getCurrentDirectory();

  // Flash effect for new items
  const flashItem = (itemPath: string) => {
    setFlashingItems(prev => new Set(prev.add(itemPath)));
    setTimeout(() => {
      setFlashingItems(prev => {
        const newSet = new Set(prev);
        newSet.delete(itemPath);
        return newSet;
      });
    }, 2000); // Flash for 2 seconds
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    if (uploading) return;
    const selected = Array.from(files);
    try {
      if (await onUpload(selected, targetDirectory)) {
        selected.forEach(file => flashItem(targetDirectory ? `${targetDirectory}/${file.name}` : file.name));
      }
    }
    finally { if (fileInputRef.current) fileInputRef.current.value = ""; }
  };

  const handleCreateDirectory = async () => {
    if (!newDirectoryName.trim()) return;

    try {
      const response = await fetch("/api/files/create-directory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: targetDirectory ? `${targetDirectory}/${newDirectoryName}` : newDirectoryName,
        }),
      });

      const result = await response.json();
      
      if (result.success) {
        const newDirPath = targetDirectory ? `${targetDirectory}/${newDirectoryName}` : newDirectoryName;
        setNewDirectoryName("");
        setShowNewDirectoryInput(false);
        onRefresh();
        flashItem(newDirPath);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error("Create directory error:", error);
      toast.error("디렉토리 생성에 실패했습니다.");
    }
  };

  const handleCreateFile = async () => {
    if (!newFileName.trim()) return;

    try {
      const response = await fetch("/api/files/create-file", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: targetDirectory,
          filename: newFileName,
        }),
      });

      const result = await response.json();
      
      if (result.success) {
        const newFilePath = targetDirectory ? `${targetDirectory}/${newFileName}` : newFileName;
        setNewFileName("");
        setShowNewFileInput(false);
        onRefresh();
        flashItem(newFilePath);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error("Create file error:", error);
      toast.error("파일 생성에 실패했습니다.");
    }
  };

  const handleDelete = async (filePath: string) => {
    try {
      const response = await fetch("/api/files/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filename: filePath,
        }),
      });

      const result = await response.json();

      if (result.success) {
        onRefresh();
        // If deleted file was selected, clear selection
        if (selectedFile === filePath) {
          onFileSelect("", false);
        }
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error("Delete error:", error);
      toast.error("파일 삭제에 실패했습니다.");
    }
  };

  const handleMoveFile = async (sourcePath: string, targetDirectory: string) => {
    try {
      const response = await fetch("/api/files/move", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sourcePath,
          targetDirectory,
        }),
      });

      const result = await response.json();

      if (result.success) {
        // If moving into a subdirectory, expand it (only if not already expanded)
        if (targetDirectory && !expandedFolders.has(targetDirectory)) {
          onFolderToggle(targetDirectory);
        }

        onRefresh();

        // Update selected file if it was the moved file
        if (selectedFile === sourcePath && result.newPath) {
          onFileSelect(result.newPath, false);
        }

        // Flash the moved file in its new location
        if (result.newPath) {
          flashItem(result.newPath);
        }

        // Show success toast
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error("Move file error:", error);
      toast.error("파일 이동 중 오류가 발생했습니다.");
    }
  };

  // Root drop zone handlers
  const handleRootDragOver = (e: React.DragEvent) => {
    // Only handle if dragging from within our file tree and not over a specific directory
    if (e.dataTransfer.types.includes("text/plain") && !dragOverDirectory) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  const handleRootDragEnter = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("text/plain") && !dragOverDirectory) {
      e.preventDefault();
      setIsRootDropZone(true);
    }
  };

  const handleRootDragLeave = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("text/plain")) {
      e.preventDefault();
      // Only hide if we're leaving the container entirely and not moving to a directory
      if (!e.currentTarget.contains(e.relatedTarget as Node) && !dragOverDirectory) {
        setIsRootDropZone(false);
      }
    }
  };

  const handleRootDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("text/plain")) {
      e.preventDefault();
      setIsRootDropZone(false);
      setDragOverDirectory(null);

      const sourcePath = e.dataTransfer.getData("text/plain");
      if (sourcePath) {
        // Move to root directory (empty string)
        handleMoveFile(sourcePath, "");
      }
    }
  };

  const handleDragOverDirectoryChange = (directory: string | null) => {
    setDragOverDirectory(directory);
    // Clear root drop zone when over a specific directory
    if (directory) {
      setIsRootDropZone(false);
    }
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="p-2 border-b border-border bg-secondary">
        <div className="space-y-2">
          <div className="text-xs mb-1 truncate">
            <span className="text-muted-foreground select-none">$ cd </span>
            <span className="text-muted-foreground">~/{targetDirectory}</span>
          </div>
          <div className="flex space-x-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="text-xs gap-1"
            >
              <Upload size={12} className="shrink-0" />
              {uploading ? "업로드중..." : "업로드"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowNewDirectoryInput(!showNewDirectoryInput)}
              className="text-xs gap-1"
            >
              <FolderPlus size={12} className="shrink-0" /> 폴더
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowNewFileInput(!showNewFileInput)}
              className="text-xs gap-1"
            >
              <FilePlus size={12} className="shrink-0" /> 파일
            </Button>
          </div>

          {showNewDirectoryInput && (
            <div className="flex space-x-1">
              <input
                type="text"
                value={newDirectoryName}
                onChange={(e) => setNewDirectoryName(e.target.value)}
                placeholder="폴더 이름"
                className="flex-1 px-2 py-1 text-xs border border-border rounded"
                onKeyDown={(e) => e.key === "Enter" && handleCreateDirectory()}
              />
              <Button size="sm" onClick={handleCreateDirectory} className="text-xs">
                생성
              </Button>
            </div>
          )}

          {showNewFileInput && (
            <div className="flex space-x-1">
              <input
                type="text"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                placeholder="파일 이름 (예: test.html)"
                className="flex-1 px-2 py-1 text-xs border border-border rounded"
                onKeyDown={(e) => e.key === "Enter" && handleCreateFile()}
              />
              <Button size="sm" onClick={handleCreateFile} className="text-xs">
                생성
              </Button>
            </div>
          )}
        </div>

        <input
          type="file"
          ref={fileInputRef}
          onChange={handleUpload}
          multiple
          className="hidden"
        />
      </div>

      {/* File Tree */}
      <div className="p-2">
        {files.map((file) => (
          <TreeNode
            key={file.path}
            node={file}
            selectedFile={selectedFile}
            expandedFolders={expandedFolders}
            onFileSelect={onFileSelect}
            onFolderToggle={onFolderToggle}
            onDelete={handleDelete}
            flashingItems={flashingItems}
            onMoveFile={handleMoveFile}
            dragOverDirectory={dragOverDirectory}
            onDragOverDirectoryChange={handleDragOverDirectoryChange}
          />
        ))}

        {files.length === 0 && (
          <div className="text-center text-muted-foreground py-8">
            <FolderOpen size={40} className="mx-auto mb-2" strokeWidth={1.25} />
            <p className="text-sm">파일이 없습니다</p>
          </div>
        )}

        {/* Root Drop Zone at bottom */}
        <div
          className={`mt-4 p-4 border-2 border-dashed rounded-lg text-center transition-all duration-200 ${
            isRootDropZone
              ? "bg-primary/20 border-primary text-primary"
              : "border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/50"
          }`}
          onDragOver={handleRootDragOver}
          onDragEnter={handleRootDragEnter}
          onDragLeave={handleRootDragLeave}
          onDrop={handleRootDrop}
        >
          <Folder size={24} className="mx-auto mb-2" strokeWidth={1.25} />
          <div className="text-sm font-medium">
            {isRootDropZone ? "루트 폴더로 이동" : "루트 폴더"}
          </div>
          <div className="text-xs text-muted-foreground/70 mt-1">
            파일을 여기로 드래그하여 루트로 이동
          </div>
        </div>
      </div>
    </div>
  );
}
