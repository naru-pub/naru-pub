import { sql } from "kysely";
import { db } from "@/lib/database";
import {
  MAX_ATTEMPTS,
  PAYMENT_QUEUE,
  PAYMENT_TASK,
  type PaymentJob,
} from "@/lib/payments/payment-jobs";
import { recordPaymentEvent } from "@/lib/payments/payment-events";

export class TaskRecoveryError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

// Retry the original task, preserving inputs, checkpoints and idempotency key.
// Absurd's retry and the operator audit commit in the same transaction.
export async function retryPaymentTask(
  taskId: string,
  operator: { id: string; loginName: string },
  reason: string,
) {
  if (!reason.trim() || reason.length > 200)
    throw new TaskRecoveryError(
      "재시도 사유를 200자 이내로 입력해 주세요.",
      400,
    );
  return db.transaction().execute(async (trx) => {
    const task = await trx
      .selectFrom("absurd.t_payments")
      .selectAll()
      .where("task_id", "=", taskId)
      .forUpdate()
      .executeTakeFirst();
    if (!task || task.task_name !== PAYMENT_TASK)
      throw new TaskRecoveryError("작업을 찾을 수 없습니다.", 404);
    if (task.state !== "failed")
      throw new TaskRecoveryError(
        "실패로 끝난 작업만 다시 시도할 수 있습니다.",
        409,
      );
    const { job } = task.params as { job: PaymentJob };
    const paymentId = "paymentId" in job ? job.paymentId : null;
    const subscriptionId = "subscriptionId" in job ? job.subscriptionId : null;
    const payment = paymentId
      ? await trx
          .selectFrom("payments")
          .select("user_id")
          .where("id", "=", paymentId)
          .executeTakeFirst()
      : null;
    const subscription = subscriptionId
      ? await trx
          .selectFrom("subscriptions")
          .select("user_id")
          .where("id", "=", subscriptionId)
          .executeTakeFirst()
      : null;
    await sql`select * from absurd.retry_task(${PAYMENT_QUEUE}, ${taskId}::uuid,
      ${JSON.stringify({ max_attempts: task.attempts + MAX_ATTEMPTS })}::jsonb)`.execute(
      trx,
    );
    await recordPaymentEvent(trx, {
      kind: "job_retried",
      userId:
        payment?.user_id ??
        subscription?.user_id ??
        ("userId" in job ? job.userId : null),
      paymentId,
      subscriptionId,
      summary: `운영자 ${operator.loginName} (${operator.id}) 작업 ${taskId} 재시도: ${reason.trim()}`,
    });
    return { taskId, state: "pending" };
  });
}

export async function paymentTaskRecoveryList() {
  return db
    .selectFrom("absurd.t_payments as t")
    .leftJoin("absurd.r_payments as r", "r.run_id", "t.last_attempt_run")
    .select([
      "t.task_id",
      "t.state",
      "t.params",
      "t.attempts",
      "t.max_attempts",
      "r.available_at",
      sql<unknown>`(select failure_reason from absurd.r_payments e where e.task_id=t.task_id and e.failure_reason is not null order by e.attempt desc limit 1)`.as(
        "last_error",
      ),
    ])
    .where("t.task_name", "=", PAYMENT_TASK)
    .where("t.state", "in", ["pending", "running", "sleeping", "failed"])
    .orderBy(sql<number>`case when t.state = 'failed' then 0 else 1 end`)
    .orderBy("t.enqueue_at", "desc")
    .limit(100)
    .execute();
}
