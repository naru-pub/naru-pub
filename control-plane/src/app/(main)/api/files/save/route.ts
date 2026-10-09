import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { validateRequest } from "@/lib/auth";
import { s3Client } from "@/lib/s3";
import { assertJsonContentType } from "@/lib/utils";
import { getUserObjectKey } from "@/lib/site-urls";
import { assertNoPathTraversal } from "@/lib/file-paths";
import * as Sentry from "@sentry/nextjs";
import { purgeSiteFiles } from "@/lib/cache-purge";
import {
  EDITABLE_FILE_EXTENSIONS,
  FILE_EXTENSION_MIMETYPE_MAP,
} from "@/lib/const";
import { db, recordSiteEdit } from "@/lib/database";
import { extractHtmlTitle } from "@/lib/html";

function assertEditableFilename(filename: string) {
  const extension = filename.split(".").pop();
  if (!extension || !EDITABLE_FILE_EXTENSIONS.includes(extension)) {
    throw new Error(`File type ${extension} is not editable.`);
  }
}

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

    const { filename, contents } = await request.json();

    if (!filename || typeof contents !== "string") {
      return NextResponse.json(
        { success: false, message: "파일명과 내용이 필요합니다." },
        { status: 400 },
      );
    }

    // The same cap as uploads, so the editor is not a way around it.
    if (Buffer.byteLength(contents) > 1024 * 1024 * 10) {
      return NextResponse.json(
        { success: false, message: "10MB 이하의 파일만 저장할 수 있습니다." },
        { status: 400 },
      );
    }

    try {
      assertNoPathTraversal(filename);
      assertEditableFilename(filename);
    } catch (e: any) {
      return NextResponse.json(
        { success: false, message: e.message },
        { status: 400 },
      );
    }

    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME!,
          Key: getUserObjectKey(user.loginName, filename),
          Body: contents,
          ContentType: FILE_EXTENSION_MIMETYPE_MAP[filename.split(".").pop()!],
        }),
      );
    } catch (e) {
      console.error("S3 save error:", e);
      return NextResponse.json(
        { success: false, message: "파일 저장에 실패했습니다." },
        { status: 500 },
      );
    }

    try {
      await recordSiteEdit(user.id);
    } catch (e) {
      Sentry.captureException(e);
    }

    if (filename === "index.html" || filename === "index.htm") {
      try {
        const title =
          typeof contents === "string" ? extractHtmlTitle(contents) : null;
        await db
          .updateTable("users")
          .set({ site_title: title })
          .where("id", "=", user.id)
          .execute();
      } catch (e) {
        Sentry.captureException(e);
      }
    }

    try {
      await purgeSiteFiles(user.loginName, [filename]);
    } catch (e) {
      Sentry.captureException(e);
    }

    return NextResponse.json({
      success: true,
      message: "파일이 저장되었습니다.",
    });
  } catch (error) {
    console.error("Save file error:", error);
    return NextResponse.json(
      { success: false, message: "파일 저장에 실패했습니다." },
      { status: 500 },
    );
  }
}
