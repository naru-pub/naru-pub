import { NextRequest, NextResponse } from "next/server";
import { assertSameOriginRequest } from "@/lib/utils";
import {
  deleteSessionCookie,
  invalidateSession,
  validateRequest,
} from "@/lib/auth";
import { db } from "@/lib/database";
import {
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { s3Client } from "@/lib/s3";
import { getSiteScreenshotKey, getUserHomeDirectory } from "@/lib/site-urls";
import { dispatchActorDelete } from "@/lib/federation";
import { deleteCustomDomainsForUser } from "@/lib/customDomains";
import { verify } from "@node-rs/argon2";
import { deleteUserMedia } from "@/lib/site-data/media";
import { eraseSiteData } from "@/lib/edge/client";
import { deleteUserTemplateObjects } from "@/lib/board/templates";
import {
  CHARGE_IN_FLIGHT_MESSAGE,
  DELETION_LOCK_WAIT_MS,
  deleteUserRow,
  settleChargesBeforeDeletion,
} from "@/lib/account-deletion";
import { AccountBusyError, withAccountLock } from "@/lib/payments/account-lock";
import { deleteRetiredBillingKey } from "@/lib/payments/billing-keys";

export async function POST(request: NextRequest) {
  try {
    try {
      assertSameOriginRequest(request);
    } catch {
      return NextResponse.json(
        { success: false, message: "잘못된 요청입니다." },
        { status: 400 },
      );
    }

    const { user, session } = await validateRequest();
    if (!user) {
      return NextResponse.json(
        { success: false, message: "로그인이 필요합니다." },
        { status: 401 },
      );
    }

    const { password } = await request.json();
    if (!password) {
      return NextResponse.json(
        { success: false, message: "비밀번호를 입력해주세요." },
        { status: 400 },
      );
    }

    const databaseUser = await db
      .selectFrom("users")
      .select("password_hash")
      .where("id", "=", user.id)
      .executeTakeFirst();

    if (!databaseUser) {
      return NextResponse.json(
        { success: false, message: "사용자가 존재하지 않습니다." },
        { status: 404 },
      );
    }

    const passwordVerified = await verify(databaseUser.password_hash, password);
    if (!passwordVerified) {
      return NextResponse.json(
        { success: false, message: "비밀번호가 일치하지 않습니다." },
        { status: 400 },
      );
    }

    // Only allow immediate deletion for users without verified email
    if (user.email && user.emailVerifiedAt) {
      return NextResponse.json(
        {
          success: false,
          message: "이메일이 인증된 계정은 이메일 확인을 통해 삭제해야 합니다.",
        },
        { status: 400 },
      );
    }

    // Before anything is deleted: a refusal must leave the account whole.
    if (!(await settleChargesBeforeDeletion(user.id))) {
      return NextResponse.json(
        { success: false, message: CHARGE_IN_FLIGHT_MESSAGE },
        { status: 409 },
      );
    }

    // List all objects with user's prefix (with pagination to ensure we delete everything)
    const allObjects: any[] = [];
    let continuationToken: string | undefined;

    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET_NAME!,
        Prefix: `${getUserHomeDirectory(user.loginName)}/`,
        ContinuationToken: continuationToken,
      });

      const objects = await s3Client.send(listCommand);

      if (objects.Contents) {
        allObjects.push(...objects.Contents);
      }

      continuationToken = objects.NextContinuationToken;
    } while (continuationToken);

    if (allObjects.length > 0) {
      // Delete all objects in batches (AWS limit is 1000 objects per delete request)
      const batchSize = 1000;
      for (let i = 0; i < allObjects.length; i += batchSize) {
        const batch = allObjects.slice(i, i + batchSize);
        await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Delete: {
              Objects: batch.map((obj) => ({ Key: obj.Key! })),
            },
          }),
        );
      }
    }

    await deleteUserMedia(user.id);
    // The site's database is a Durable Object, outside this database.
    await eraseSiteData(user.loginName);
    // Template snapshots and the site screenshot live outside the home
    // directory.
    await deleteUserTemplateObjects(user.id);
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: getSiteScreenshotKey(user.loginName),
      }),
    );

    // Federate the account deletion before account content and federation keys are removed. Failure here must not block deletion.
    try {
      await dispatchActorDelete(user.id, user.loginName);
    } catch (err) {
      console.error("Failed to federate account deletion:", err);
    }

    await deleteCustomDomainsForUser(user.id);

    // Anonymize the account and remove content, retaining financial history.
    const billingKey = await withAccountLock(
      user.id,
      { waitMs: DELETION_LOCK_WAIT_MS },
      () => db.transaction().execute((trx) => deleteUserRow(trx, user.id)),
    );
    await deleteRetiredBillingKey(billingKey);

    // Invalidate session
    if (session) {
      await invalidateSession(session.id);
    }

    await deleteSessionCookie();

    return NextResponse.json({
      success: true,
      message: "계정이 성공적으로 삭제되었습니다.",
    });
  } catch (error) {
    // Another payment operation on the account did not finish in time.
    if (error instanceof AccountBusyError) {
      return NextResponse.json(
        { success: false, message: CHARGE_IN_FLIGHT_MESSAGE },
        { status: 409 },
      );
    }
    console.error("Immediate account deletion error:", error);
    return NextResponse.json(
      { success: false, message: "계정 삭제 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
