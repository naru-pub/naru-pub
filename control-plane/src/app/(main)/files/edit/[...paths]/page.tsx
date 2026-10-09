import { validateRequest } from "@/lib/auth";
import { HeadObjectCommand, NotFound } from "@aws-sdk/client-s3";
import { s3Client } from "@/lib/s3";
import { getUserObjectKey } from "@/lib/site-urls";
import { buildFileTree } from "@/lib/fileUtils";
import FileExplorerWithSelected from "@/components/browser/FileExplorerWithSelected";

export default async function EditPage(props: {
  params: Promise<{ paths: string[] }>;
}) {
  const params = await props.params;
  const { user } = await validateRequest();

  if (!user) {
    return (
      <div className="max-w-md mx-auto p-6">
        <div className="bg-card border-2 border-line p-6 text-center">
          <h1 className="text-xl font-bold text-foreground mb-2">로그인 필요</h1>
          <p className="text-muted-foreground">파일 편집을 위해 로그인이 필요합니다.</p>
        </div>
      </div>
    );
  }

  const decodedPaths = params.paths.map((p) => decodeURIComponent(p));
  const filename = decodedPaths.join("/");
  const actualFilename = getUserObjectKey(user.loginName, filename);

  // Check if file exists
  const headCommand = new HeadObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: actualFilename,
  });

  let fileExists = true;
  try {
    await s3Client.send(headCommand);
  } catch (e) {
    if (e instanceof NotFound) {
      fileExists = false;
    } else {
      throw e;
    }
  }

  const fileTree = await buildFileTree(user.loginName);

  return (
    <div className="w-full h-full">
      <FileExplorerWithSelected
        initialFiles={fileTree}
        userLoginName={user.loginName}
        initialSelectedFile={fileExists ? filename : null}
      />
    </div>
  );
}
