import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "~/server/db";

export async function GET() {
	try {
		await db.execute(sql`select 1`);
		return NextResponse.json(
			{ status: "ok" },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch {
		return NextResponse.json(
			{ status: "error" },
			{ status: 503, headers: { "Cache-Control": "no-store" } },
		);
	}
}
