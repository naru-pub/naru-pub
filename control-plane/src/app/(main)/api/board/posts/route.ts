import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/board/access";
import { isPostKind } from "@/lib/board/constants";
import { BoardError, boardErrorResponse, readJson } from "@/lib/board/errors";
import { createPost } from "@/lib/board/posts";
import { publishTemplatePost } from "@/lib/board/templates";
import { dispatchTemplatePost } from "@/lib/federation";

export async function POST(request: NextRequest) {
  try {
    const body = await readJson(request);
    const user = await requireVerifiedUser();
    if (!isPostKind(body.kind)) {
      throw new BoardError(400, "글 종류를 골라 주세요.");
    }

    if (body.kind !== "template") {
      const postId = await createPost(user, {
        kind: body.kind,
        title: body.title,
        body: body.body,
      });
      return NextResponse.json({ success: true, postId });
    }

    const { postId } = await publishTemplatePost(user, {
      title: body.title,
      body: body.body,
      slug: body.slug,
      cc0Accepted: body.cc0Accepted,
      files: body.files,
      collections: body.collections,
    });
    // The post is up whether or not the fediverse hears about it.
    try {
      await dispatchTemplatePost(postId);
    } catch (error) {
      console.error("[board] federating template post failed", error);
    }
    return NextResponse.json({ success: true, postId });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
