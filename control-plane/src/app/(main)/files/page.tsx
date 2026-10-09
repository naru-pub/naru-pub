import { validateRequest } from "@/lib/auth";
import FileExplorer from "@/components/browser/FileExplorer";
import { buildFileTree } from "@/lib/fileUtils";

export default async function File() {
  const { user } = await validateRequest();

  if (!user) {
    return (
      <div className="max-w-md mx-auto p-6">
        <div className="bg-card border-2 border-line p-6 text-center">
          <h1 className="text-xl font-bold text-foreground mb-2">로그인 필요</h1>
          <p className="text-muted-foreground">파일 관리를 위해 로그인이 필요합니다.</p>
        </div>
      </div>
    );
  }

  const fileTree = await buildFileTree(user.loginName);

  return (
    <div className="w-full h-full">
      <FileExplorer initialFiles={fileTree} userLoginName={user.loginName} />
    </div>
  );
}
