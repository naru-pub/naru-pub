import { db } from "@/lib/database";
import { setTossCallRecorder, type TossCallRecord } from "@/lib/toss";

// Keeps every Toss call in toss_calls (see the migration that adds it). Best
// effort: a call whose record cannot be written still returns its answer.
// Imported for its effect by lib/toss-gateway.ts, through which the payment
// code reaches Toss.
async function keepTossCall(
  record: TossCallRecord,
  orderId: string | null,
): Promise<void> {
  try {
    const response = record.responseBody;
    const errorCode =
      response && typeof response === "object"
        ? (response as { code?: unknown }).code
        : undefined;
    await db
      .insertInto("toss_calls")
      .values({
        flow: record.flow,
        method: record.method,
        path: record.path.slice(0, 500),
        order_id: orderId?.slice(0, 100) ?? null,
        http_status: record.status,
        error_code:
          record.status != null &&
          record.status >= 400 &&
          typeof errorCode === "string"
            ? errorCode.slice(0, 100)
            : null,
        error: record.error?.slice(0, 2000) ?? null,
        request_body:
          record.requestBody == null
            ? null
            : JSON.stringify(record.requestBody),
        response_body:
          response == null
            ? null
            : JSON.stringify(
                typeof response === "string" ? { text: response } : response,
              ),
        duration_ms: record.durationMs,
      })
      .execute();
  } catch (error) {
    console.error("Toss call could not be recorded:", error);
  }
}

if (process.env.DATABASE_URL) setTossCallRecorder(keepTossCall);
