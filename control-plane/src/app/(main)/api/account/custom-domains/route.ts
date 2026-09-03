import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { assertJsonContentType } from "@/lib/utils";
import { userHasFeature } from "@/lib/entitlements";
import { noteSupporterFeatureUse } from "@/lib/feature-usage";
import {
  createCloudflareCustomHostname,
  deleteCloudflareCustomHostnameIfExists,
  getCloudflareCustomHostname,
  normalizeHostname,
  toCustomDomainRow,
} from "@/lib/customDomains";

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

    if (!(await userHasFeature(user.id, "custom_domains"))) {
      return NextResponse.json(
        {
          success: false,
          message: "커스텀 도메인 사용 권한이 없습니다.",
        },
        { status: 403 },
      );
    }

    const { hostname } = await request.json();
    if (typeof hostname !== "string") {
      return NextResponse.json(
        { success: false, message: "도메인을 입력해주세요." },
        { status: 400 },
      );
    }

    let normalizedHostname: string;
    try {
      normalizedHostname = normalizeHostname(hostname);
    } catch (error) {
      return NextResponse.json(
        {
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "유효한 도메인을 입력해주세요.",
        },
        { status: 400 },
      );
    }

    const existingDomain = await db
      .selectFrom("custom_domains")
      .select(["id", "user_id"])
      .where("hostname", "=", normalizedHostname)
      .executeTakeFirst();

    if (existingDomain && existingDomain.user_id !== user.id) {
      return NextResponse.json(
        { success: false, message: "이미 등록된 도메인입니다." },
        { status: 409 },
      );
    }

    if (existingDomain) {
      return NextResponse.json({
        success: true,
        message: "이미 등록된 도메인입니다.",
      });
    }

    const ownedCount = await db
      .selectFrom("custom_domains")
      .select(({ fn }) => fn.countAll().as("count"))
      .where("user_id", "=", user.id)
      .executeTakeFirst();

    if (ownedCount && Number(ownedCount.count) >= 1) {
      return NextResponse.json(
        {
          success: false,
          message: "커스텀 도메인은 계정당 하나만 등록할 수 있습니다.",
        },
        { status: 409 },
      );
    }

    const cloudflareHostname =
      await createCloudflareCustomHostname(normalizedHostname);

    try {
      await db
        .insertInto("custom_domains")
        .values({
          user_id: user.id,
          hostname: normalizedHostname,
          ...toCustomDomainRow(cloudflareHostname),
        })
        .execute();
    } catch (error) {
      await deleteCloudflareCustomHostnameIfExists(cloudflareHostname.id);
      if ((error as { code?: string }).code === "23505") {
        return NextResponse.json(
          {
            success: false,
            message: "이미 등록된 도메인이 있습니다.",
          },
          { status: 409 },
        );
      }
      throw error;
    }

    noteSupporterFeatureUse(user.id, "custom_domains");

    return NextResponse.json({
      success: true,
      message: "도메인이 추가되었습니다. DNS 설정 후 상태를 확인해주세요.",
    });
  } catch (error) {
    console.error("Custom domain add error:", error);
    return NextResponse.json(
      { success: false, message: "도메인 추가 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
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

    if (!(await userHasFeature(user.id, "custom_domains"))) {
      return NextResponse.json(
        { success: false, message: "커스텀 도메인 사용 권한이 없습니다." },
        { status: 403 },
      );
    }

    const { id } = await request.json();
    if (typeof id !== "number") {
      return NextResponse.json(
        { success: false, message: "유효하지 않은 도메인입니다." },
        { status: 400 },
      );
    }

    const domain = await db
      .selectFrom("custom_domains")
      .select(["id", "cloudflare_hostname_id"])
      .where("id", "=", id)
      .where("user_id", "=", user.id)
      .executeTakeFirst();

    if (!domain) {
      return NextResponse.json(
        { success: false, message: "도메인을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    const cloudflareHostname = await getCloudflareCustomHostname(
      domain.cloudflare_hostname_id,
    );
    const row = toCustomDomainRow(cloudflareHostname);

    await db
      .updateTable("custom_domains")
      .set(row)
      .where("id", "=", domain.id)
      .where("user_id", "=", user.id)
      .execute();

    return NextResponse.json({
      success: true,
      message: row.verified_at
        ? "도메인이 활성화되었습니다."
        : "Cloudflare 상태를 갱신했습니다. DNS와 인증 레코드를 확인해주세요.",
    });
  } catch (error) {
    console.error("Custom domain verification error:", error);
    return NextResponse.json(
      { success: false, message: "도메인 인증 중 오류가 발생했습니다." },
      { status: 500 },
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

    const { id } = await request.json();
    if (typeof id !== "number") {
      return NextResponse.json(
        { success: false, message: "유효하지 않은 도메인입니다." },
        { status: 400 },
      );
    }

    const domain = await db
      .selectFrom("custom_domains")
      .select(["id", "cloudflare_hostname_id"])
      .where("id", "=", id)
      .where("user_id", "=", user.id)
      .executeTakeFirst();

    if (!domain) {
      return NextResponse.json(
        { success: false, message: "도메인을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    try {
      await deleteCloudflareCustomHostnameIfExists(
        domain.cloudflare_hostname_id,
      );
    } catch (error) {
      console.error("Cloudflare custom hostname delete error:", error);
      return NextResponse.json(
        {
          success: false,
          message: "Cloudflare 도메인 삭제 중 오류가 발생했습니다.",
        },
        { status: 502 },
      );
    }

    await db
      .deleteFrom("custom_domains")
      .where("id", "=", domain.id)
      .where("user_id", "=", user.id)
      .execute();

    return NextResponse.json({
      success: true,
      message: "도메인이 삭제되었습니다.",
    });
  } catch (error) {
    console.error("Custom domain delete error:", error);
    return NextResponse.json(
      { success: false, message: "도메인 삭제 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
