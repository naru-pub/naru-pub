import { NextRequest, NextResponse } from "next/server";
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
import { assertJsonContentType } from "@/lib/utils";
import { getSiteScreenshotKey, getUserHomeDirectory } from "@/lib/site-urls";
import { dispatchActorDelete } from "@/lib/federation";
import { deleteCustomDomainsForUser } from "@/lib/customDomains";
import { verify } from "@node-rs/argon2";
import { deleteUserMedia } from "@/lib/site-data/media";
import { deleteUserTemplateObjects } from "@/lib/board/templates";
import {
  CHARGE_IN_FLIGHT_MESSAGE,
  ChargeInFlightError,
  deleteUserRow,
  settleChargesBeforeDeletion,
} from "@/lib/account-deletion";
import { deleteRetiredBillingKey } from "@/lib/billing-keys";

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

    const { token, password } = await request.json();

    if (!token) {
      return NextResponse.json(
        { success: false, message: "삭제 토큰이 필요합니다." },
        { status: 400 },
      );
    }

    const deletionToken = await db
      .selectFrom("account_deletion_tokens")
      .selectAll()
      .where("id", "=", token)
      .where("expires_at", ">", new Date())
      .executeTakeFirst();

    if (!deletionToken) {
      return NextResponse.json(
        {
          success: false,
          message: "유효하지 않거나 만료된 계정 삭제 토큰입니다.",
        },
        { status: 400 },
      );
    }

    const { user, session } = await validateRequest();
    if (!user || user.id !== deletionToken.user_id) {
      return NextResponse.json(
        { success: false, message: "계정 삭제 권한이 없습니다." },
        { status: 403 },
      );
    }

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
    // Template snapshots and the site screenshot live outside the home
    // directory.
    await deleteUserTemplateObjects(user.id);
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: getSiteScreenshotKey(user.loginName),
      }),
    );

    // Federate the account deletion before the row (and its keys/followers)
    // cascade away. Failure here must not block deletion.
    try {
      await dispatchActorDelete(user.id, user.loginName);
    } catch (err) {
      console.error("Failed to federate account deletion:", err);
    }

    await deleteCustomDomainsForUser(user.id);

    const billingKey = await db.transaction().execute(async (trx) => {
      // Delete the account deletion token
      await trx
        .deleteFrom("account_deletion_tokens")
        .where("id", "=", token)
        .execute();

      // Delete user account (this will cascade to all related tables)
      return deleteUserRow(trx, user.id);
    });
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
    // A charge started between the check above and the delete.
    if (error instanceof ChargeInFlightError) {
      return NextResponse.json(
        { success: false, message: CHARGE_IN_FLIGHT_MESSAGE },
        { status: 409 },
      );
    }
    console.error("Account deletion error:", error);
    return NextResponse.json(
      { success: false, message: "계정 삭제 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
