import { NextRequest, NextResponse } from "next/server";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { validateRequest } from "@/lib/auth";
import { s3Client } from "@/lib/s3";
import { assertJsonContentType } from "@/lib/utils";
import { getUserObjectKey } from "@/lib/site-urls";
import { assertNoPathTraversal } from "@/lib/file-paths";
import * as Sentry from "@sentry/nextjs";
import { purgeSiteFiles } from "@/lib/cache-purge";
import { recordSiteEdit } from "@/lib/database";
import { revalidatePath } from "next/cache";

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

    const { user } = await validateRequest();
    if (!user) {
      return NextResponse.json(
        { success: false, message: "로그인이 필요합니다." },
        { status: 401 },
      );
    }

    const { filename } = await request.json();

    if (!filename) {
      return NextResponse.json(
        { success: false, message: "파일명이 필요합니다." },
        { status: 400 },
      );
    }

    try {
      assertNoPathTraversal(filename);
    } catch (e: any) {
      return NextResponse.json(
        { success: false, message: e.message },
        { status: 400 },
      );
    }

    if (filename === "/index.html") {
      return NextResponse.json(
        { success: false, message: "홈 페이지는 삭제할 수 없습니다." },
        { status: 400 },
      );
    }

    const key = getUserObjectKey(user.loginName, filename);

    try {
      // List all objects with the prefix
      const listCommand = new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET_NAME!,
        Prefix: key,
      });
      const objects = await s3Client.send(listCommand);

      // Delete all objects with the prefix
      if (objects.Contents && objects.Contents.length > 0) {
        await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Delete: {
              Objects: objects.Contents.map((obj) => ({ Key: obj.Key! })),
            },
          }),
        );
      }

      for (const obj of objects.Contents ?? []) {
        if (obj.Key) {
          // Extract filename from S3 key safely
          const keyParts = obj.Key.split("/");
          const filename = keyParts[keyParts.length - 1];
          await purgeSiteFiles(user.loginName, [filename]);
        }
      }
    } catch (e) {
      Sentry.captureException(e);
      console.error("S3 delete error:", e);
      return NextResponse.json(
        { success: false, message: "파일 삭제에 실패했습니다." },
        { status: 500 },
      );
    }

    revalidatePath("/files", "layout");
    await recordSiteEdit(user.id);

    return NextResponse.json({
      success: true,
      message: "파일이 삭제되었습니다.",
    });
  } catch (error) {
    console.error("Delete error:", error);
    return NextResponse.json(
      { success: false, message: "파일 삭제에 실패했습니다." },
      { status: 500 },
    );
  }
}
