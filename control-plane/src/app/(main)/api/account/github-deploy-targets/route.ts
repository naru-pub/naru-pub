import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { noteSupporterFeatureUse } from "@/lib/feature-usage";
import { assertJsonContentType } from "@/lib/utils";
import { upsertGitHubDeployTarget } from "@/lib/deploy/siteDeploy";

export async function GET() {
  const { user } = await validateRequest();
  if (!user) {
    return NextResponse.json(
      { success: false, message: "로그인이 필요합니다." },
      { status: 401 },
    );
  }

  const targets = await db
    .selectFrom("github_deploy_targets")
    .select([
      "id",
      "github_repository",
      "github_ref",
      "target_prefix",
      "delete_removed_files",
      "enabled",
      "last_github_sha",
      "last_deployed_at",
      "created_at",
      "updated_at",
    ])
    .where("user_id", "=", user.id)
    .orderBy("created_at", "desc")
    .execute();

  return NextResponse.json({ success: true, targets });
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

    if (!(await userHasFeature(user.id, "github_deploys"))) {
      return NextResponse.json(
        {
          success: false,
          message: "GitHub 배포는 후원자 전용 기능입니다.",
        },
        { status: 403 },
      );
    }

    const body = await request.json();
    await upsertGitHubDeployTarget({
      user,
      githubRepository: String(body.githubRepository ?? ""),
      githubRef: String(body.githubRef ?? ""),
      targetPrefix: body.targetPrefix,
      deleteRemovedFiles:
        typeof body.deleteRemovedFiles === "boolean"
          ? body.deleteRemovedFiles
          : undefined,
    });
    noteSupporterFeatureUse(user.id, "github_deploys");

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "GitHub deploy target could not be saved",
      },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest) {
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

    const body = await request.json();
    const id = Number(body.id);
    if (!Number.isSafeInteger(id)) {
      return NextResponse.json(
        { success: false, message: "id is required" },
        { status: 400 },
      );
    }

    await db
      .updateTable("github_deploy_targets")
      .set({ enabled: false, updated_at: new Date() })
      .where("id", "=", id)
      .where("user_id", "=", user.id)
      .execute();

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "GitHub deploy target could not be disabled",
      },
      { status: 400 },
    );
  }
}
