import { NextResponse } from "next/server";
import { sql } from "kysely";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { parseUuid } from "@/lib/uuid";

const reply = (body: object, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

// Read the durable result only. Polling never contacts Toss or executes work.
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { user } = await validateRequest();
  if (!user)
    return reply({ success: false, message: "로그인이 필요합니다." }, 401);
  const id = parseUuid((await context.params).id);
  if (!id)
    return reply({ success: false, message: "잘못된 결제 번호입니다." }, 400);
  const payment = await db
    .selectFrom("payments as p")
    .leftJoin("subscriptions as s", "s.id", "p.subscription_id")
    .select([
      "p.status",
      "s.status as subscription_status",
      "s.next_billing_at",
      sql<boolean>`exists (select 1 from absurd.t_payments t
        where t.params->'job'->>'paymentId' = p.id::text
        and t.params->'job'->>'kind' in ('confirm_one_time', 'initial_subscription_charge')
        and t.state = 'failed')`.as("task_failed"),
    ])
    .where("p.id", "=", id)
    .where("p.user_id", "=", user.id)
    .executeTakeFirst();
  if (!payment)
    return reply(
      { success: false, message: "결제 내역을 찾을 수 없습니다." },
      404,
    );
  if (payment.status === "done")
    return reply({
      success: true,
      state: "completed",
      message: "결제가 완료되었습니다. 감사합니다!",
    });
  if (
    payment.status === "expired" &&
    payment.subscription_status === "scheduled" &&
    payment.next_billing_at
  )
    return reply({
      success: true,
      state: "scheduled",
      message: "현재 이용 기간이 끝난 뒤 정기 결제가 시작됩니다.",
    });
  if (payment.status !== "pending")
    return reply({
      success: true,
      state: "failed",
      message: "결제가 완료되지 않았습니다. 결제 내역을 확인해 주세요.",
    });
  if (payment.task_failed)
    return reply({
      success: true,
      state: "needs_attention",
      message:
        "결제 결과 확인이 지연되어 운영자 확인이 필요합니다. 다시 결제하지 말고 운영자에게 문의해 주세요.",
    });
  return reply({
    success: true,
    state: "processing",
    message: "결제를 처리하고 있습니다. 잠시만 기다려 주세요.",
  });
}
