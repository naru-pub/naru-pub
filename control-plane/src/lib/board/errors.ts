import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { assertJsonContentType } from "@/lib/utils";
import type { NextRequest } from "next/server";
import { parseUuid } from "@/lib/uuid";

// A failure the person can act on. Its message is shown as is.
export class BoardError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function boardErrorResponse(error: unknown) {
  if (error instanceof BoardError) {
    return NextResponse.json(
      { success: false, message: error.message },
      { status: error.status },
    );
  }
  console.error("[board]", error);
  Sentry.captureException(error);
  return NextResponse.json(
    { success: false, message: "요청을 처리하지 못했습니다." },
    { status: 500 },
  );
}

// Parses a mutating request's JSON body, refusing form posts and other
// origins the way the file routes do.
export async function readJson(
  request: NextRequest,
): Promise<Record<string, unknown>> {
  try {
    assertJsonContentType(request);
  } catch {
    throw new BoardError(400, "잘못된 요청입니다.");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BoardError(400, "잘못된 요청입니다.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BoardError(400, "잘못된 요청입니다.");
  }
  return body as Record<string, unknown>;
}

// Route params and body fields that name a row. Every board row is keyed by a
// UUID (posts since 1790747807041, the rest since 1790824144110).
export function parseId(value: unknown): string {
  const id = parseUuid(value);
  if (!id) throw new BoardError(404, "찾을 수 없습니다.");
  return id;
}

// A board post's id. Kept as its own name for the call sites that take one.
export const parsePostId = parseId;
