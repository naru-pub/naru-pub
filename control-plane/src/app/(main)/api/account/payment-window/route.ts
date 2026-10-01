import { NextRequest, NextResponse } from "next/server";
import { assertJsonContentType } from "@/lib/utils";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";

// How a Toss window the supporter opened ended, when it did not succeed: the
// code and message Toss hands the failUrl, or the popup's rejection. No API
// call ever sees them, so /support reports them here, and they are kept in
// toss_window_outcomes (see the migration that adds it). Only for a window
// this account opened — its card registration or its order — and once per
// window and code, so a reloaded page or another account adds nothing.
export async function POST(request: NextRequest) {
  try {
    assertJsonContentType(request);
  } catch {
    return NextResponse.json({ success: false }, { status: 400 });
  }
  const { user } = await validateRequest();
  if (!user) return NextResponse.json({ success: false }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    window?: unknown;
    registrationId?: unknown;
    orderId?: unknown;
    code?: unknown;
    message?: unknown;
  } | null;
  const code = typeof body?.code === "string" ? body.code.slice(0, 100) : null;
  const message =
    typeof body?.message === "string" ? body.message.slice(0, 1000) : null;
  if (!body || !code) {
    return NextResponse.json({ success: false }, { status: 400 });
  }

  let reference:
    | { window: "billing_auth"; card_registration_id: string }
    | { window: "payment"; order_id: string }
    | null = null;
  if (
    body.window === "billing_auth" &&
    typeof body.registrationId === "string"
  ) {
    const registration = await db
      .selectFrom("card_registrations")
      .select("id")
      .where("user_id", "=", user.id)
      .where("id", "=", body.registrationId)
      .executeTakeFirst()
      .catch(() => undefined);
    if (registration) {
      reference = {
        window: "billing_auth",
        card_registration_id: registration.id,
      };
    }
  } else if (body.window === "payment" && typeof body.orderId === "string") {
    const payment = await db
      .selectFrom("payments")
      .select("order_id")
      .where("user_id", "=", user.id)
      .where("order_id", "=", body.orderId)
      .executeTakeFirst();
    if (payment) reference = { window: "payment", order_id: payment.order_id };
  }
  if (!reference) {
    return NextResponse.json({ success: false }, { status: 404 });
  }

  await db
    .insertInto("toss_window_outcomes")
    .values({ user_id: user.id, ...reference, code, message })
    .onConflict((oc) => oc.doNothing())
    .execute();
  return NextResponse.json({ success: true });
}
