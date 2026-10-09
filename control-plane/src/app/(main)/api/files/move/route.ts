import { NextRequest, NextResponse } from "next/server";
import {
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { validateRequest } from "@/lib/auth";
import { s3Client } from "@/lib/s3";
import { assertJsonContentType } from "@/lib/utils";
import { collapseSlashes, getUserObjectKey } from "@/lib/site-urls";
import { assertNoPathTraversal } from "@/lib/file-paths";
import { revalidatePath } from "next/cache";
import * as Sentry from "@sentry/nextjs";
import { purgeSiteFiles } from "@/lib/cache-purge";
import { recordSiteEdit } from "@/lib/database";

export async function POST(request: NextRequest) {
  try {
    try {
      assertJsonContentType(request);
    } catch {
      return NextResponse.json(
        { success: false, message: "Invalid content type" },
        { status: 400 },
      );
    }

    const body = await request.json();
    const { sourcePath, targetDirectory } = body;

    if (!sourcePath) {
      return NextResponse.json(
        { success: false, message: "소스 파일 경로가 필요합니다." },
        { status: 400 },
      );
    }

    let fileName: string | undefined;
    let newPath: string;
    try {
      assertNoPathTraversal(sourcePath);
      if (targetDirectory) {
        assertNoPathTraversal(targetDirectory);
      }

      // Get filename from source path
      fileName = sourcePath.split("/").pop();
      if (!fileName) {
        throw new Error("유효하지 않은 파일 경로입니다.");
      }

      // Calculate new path
      newPath = collapseSlashes(
        targetDirectory ? `${targetDirectory}/${fileName}` : fileName,
      );
      assertNoPathTraversal(newPath);
    } catch (e: any) {
      return NextResponse.json(
        { success: false, message: e.message },
        { status: 400 },
      );
    }

    // If source and target are the same key, no need to move. Copying an
    // object onto itself and then deleting the source would lose it.
    if (collapseSlashes(sourcePath) === newPath) {
      return NextResponse.json({
        success: true,
        message: "파일이 이미 해당 위치에 있습니다.",
      });
    }

    // Check if a file already exists at the target location
    const { user } = await validateRequest();
    if (!user) {
      return NextResponse.json(
        { success: false, message: "로그인이 필요합니다." },
        { status: 401 },
      );
    }

    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME!,
          Key: getUserObjectKey(user.loginName, newPath),
        }),
      );

      // If we reach here, the file exists
      return NextResponse.json(
        {
          success: false,
          message: `"${fileName}" 파일이 대상 위치에 이미 존재합니다.`,
          type: "FILE_EXISTS",
        },
        { status: 409 },
      );
    } catch (error: any) {
      // If error is NotFound, the file doesn't exist - we can proceed
      if (error.name !== "NotFound") {
        throw error; // Re-throw other errors
      }
    }

    // Inline the rename functionality
    try {
      // Copy the object to new location
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME!,
          CopySource: `${process.env.S3_BUCKET_NAME}/${getUserObjectKey(
            user.loginName,
            sourcePath,
          )}`,
          Key: getUserObjectKey(user.loginName, newPath),
        }),
      );

      // Delete the old object
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME!,
          Key: getUserObjectKey(user.loginName, sourcePath),
        }),
      );

      // Invalidate Cloudflare cache
      await purgeSiteFiles(user.loginName, [sourcePath, newPath]);

      revalidatePath("/files", "layout");
      await recordSiteEdit(user.id);

      return NextResponse.json({
        success: true,
        message: `파일이 성공적으로 이동되었습니다.`,
        newPath,
      });
    } catch (moveError) {
      Sentry.captureException(moveError);
      return NextResponse.json(
        { success: false, message: "파일 이동에 실패했습니다." },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error("Move file error:", error);
    return NextResponse.json(
      { success: false, message: "파일 이동에 실패했습니다." },
      { status: 500 },
    );
  }
}
