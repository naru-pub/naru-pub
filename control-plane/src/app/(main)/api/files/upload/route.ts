import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { validateRequest } from "@/lib/auth";
import { getUserHomeDirectory, s3Client } from "@/lib/utils";
import { revalidatePath } from "next/cache";
import { User } from "@/lib/auth";
import * as Sentry from "@sentry/nextjs";
import {
  ALLOWED_FILE_EXTENSIONS,
  FILE_EXTENSION_MIMETYPE_MAP,
} from "@/lib/const";
import { streamUpload } from "@/lib/upload-progress";
import { recordSiteEdit } from "@/lib/database";

function validateFilename(filename: string) {
  // Length validation
  if (filename.length > 255) {
    throw new Error("파일명이 너무 깁니다. (최대 255자)");
  }

  if (filename.length === 0) {
    throw new Error("파일명이 비어있습니다.");
  }

  // Reserved names on Windows
  const reservedNames = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
  const nameWithoutExt = filename.split('.')[0].toUpperCase();
  if (reservedNames.includes(nameWithoutExt)) {
    throw new Error("예약된 파일명입니다.");
  }
}

function assertNoPathTraversal(filename: string) {
  if (filename.includes("..")) {
    throw new Error("Path traversal detected in filename.");
  }
  if (filename.startsWith("/")) {
    throw new Error("Absolute path detected in filename.");
  }
}

function assertAllowedFilename(filename: string) {
  validateFilename(filename);

  const parts = filename.split(".");
  if (parts.length < 2) {
    throw new Error("확장자를 입력해주세요.");
  }

  const extension = parts[parts.length - 1].toLowerCase();
  if (!extension) {
    throw new Error("확장자를 입력해주세요.");
  }

  if (!ALLOWED_FILE_EXTENSIONS.includes(extension)) {
    throw new Error(
      `지원하지 않는 파일 형식입니다. ${ALLOWED_FILE_EXTENSIONS.join(
        ", "
      )} 파일만 생성할 수 있습니다.`
    );
  }
}

async function invalidateCloudflareCacheSingleFile(user: User, filename: string) {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID!;
  const userApiToken = process.env.CLOUDFLARE_USER_API_TOKEN!;
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userApiToken}`,
    },
    body: JSON.stringify({
      files: [
        `${getUserHomeDirectory(user.loginName)}/${filename}`.replaceAll(
          "//",
          "/"
        ),
      ],
    }),
  });

  if (!response.ok) {
    Sentry.captureException(response);
  }
}

async function uploadSingleFile(user: User, directory: string, file: File) {
  if (file.size === 0) {
    return { success: false, message: "빈 파일은 업로드할 수 없습니다." };
  }

  if (file.size > 1024 * 1024 * 10) {
    return { success: false, message: "10MB 이하의 파일만 업로드할 수 있습니다." };
  }

  try {
    assertNoPathTraversal(directory);
    assertAllowedFilename(file.name);
    if (directory.length > 1000) {
      throw new Error("디렉토리 경로가 너무 깁니다.");
    }
  } catch (e: any) {
    return { success: false, message: e.message };
  }

  const data = await file.arrayBuffer();
  const key = `${getUserHomeDirectory(user.loginName)}/${directory}${
    file.name
  }`.replaceAll("//", "/");

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: key,
        Body: Buffer.from(data),
        ContentType: FILE_EXTENSION_MIMETYPE_MAP[file.name.split(".").pop()!],
      })
    );

    // Extract filename from S3 key safely for cache invalidation
    const keyParts = key.split('/');
    const filename = keyParts[keyParts.length - 1];
    await invalidateCloudflareCacheSingleFile(user, filename);
  } catch (e) {
    Sentry.captureException(e);
    console.error("S3 upload error:", e);
    return {
      success: false,
      message: "파일 업로드에 실패했습니다.",
    };
  }

  return { success: true, message: "업로드되었습니다." };
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await validateRequest();
    if (!user) {
      return NextResponse.json(
        { success: false, message: "로그인이 필요합니다." },
        { status: 401 }
      );
    }

    const formData = await request.formData();
    const directory = formData.get("directory") as string;
    const files = formData.getAll("file") as File[];

    if (!files.length) {
      return NextResponse.json(
        { success: false, message: "파일을 선택해주세요." },
        { status: 400 }
      );
    }

    if (request.headers.get("accept")?.includes("application/x-ndjson")) {
      return new Response(streamUpload(files,
        file => uploadSingleFile(user, directory, file),
        async () => { revalidatePath("/files", "layout"); await recordSiteEdit(user.id); },
      ), { headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      } });
    }

    for (const file of files) {
      const result = await uploadSingleFile(user, directory, file);
      if (!result.success) {
        return NextResponse.json(
          { success: false, message: result.message },
          { status: 400 }
        );
      }
    }

    revalidatePath("/files", "layout");
    await recordSiteEdit(user.id);

    return NextResponse.json({
      success: true,
      message: "업로드되었습니다.",
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { success: false, message: "파일 업로드에 실패했습니다." },
      { status: 500 }
    );
  }
}
