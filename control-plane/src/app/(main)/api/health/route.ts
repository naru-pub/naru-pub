import { NextResponse } from "next/server";
import { sql } from "kysely";

import { db } from "@/lib/database";

export async function GET() {
  try {
    await sql`select 1`.execute(db);
    return NextResponse.json(
      { status: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Health check failed:", error);
    return NextResponse.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
