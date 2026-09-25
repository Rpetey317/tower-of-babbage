import { timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { env } from "~/env";
import { contractVersion, eventBatchSchema } from "~/lib/contract";
import { db } from "~/server/db";
import { segments, sessionEvents, sessions } from "~/server/db/schema";
import { publish } from "~/server/events/bus";
import { recordStatus } from "~/server/events/state";
import { ensureWatchdog } from "~/server/events/watchdog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
	const expected = `Bearer ${env.SHARED_SECRET}`;
	const header = request.headers.get("authorization");
	if (!header || header.length !== expected.length) return false;
	return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

export async function POST(request: Request) {
	if (!authorized(request)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		body = undefined;
	}
	if (
		typeof body !== "object" ||
		body === null ||
		(body as { contractVersion?: unknown }).contractVersion !== contractVersion
	) {
		return NextResponse.json(
			{ error: "contract_version_mismatch" },
			{ status: 400 },
		);
	}

	const parsed = eventBatchSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "invalid_events", details: parsed.error.issues },
			{ status: 400 },
		);
	}
	const events = parsed.data.events;

	await db.transaction(async (tx) => {
		for (const event of events) {
			if (event.type === "segment") {
				const row = {
					sessionId: event.sessionId,
					runId: event.runId,
					chunkIndex: event.chunkIndex,
					kind: event.kind,
					language: event.language,
					text: event.text,
					speaker: event.speaker ?? null,
					isFinal: event.isFinal,
					startMs: event.startMs,
					endMs: event.endMs,
					emittedAt: new Date(event.emittedAt),
					latencyMs: event.latencyMs,
				};
				await tx
					.insert(segments)
					.values(row)
					.onConflictDoUpdate({
						target: [
							segments.sessionId,
							segments.runId,
							segments.chunkIndex,
							segments.language,
						],
						set: {
							kind: row.kind,
							text: row.text,
							speaker: row.speaker,
							isFinal: row.isFinal,
							startMs: row.startMs,
							endMs: row.endMs,
							emittedAt: row.emittedAt,
							latencyMs: row.latencyMs,
						},
					});
			} else if (event.type === "status") {
				await tx
					.update(sessions)
					.set({
						status: event.status,
						currentRunId: event.runId,
						lastError: event.stats.lastError,
						updatedAt: new Date(),
					})
					.where(eq(sessions.id, event.sessionId));
			} else {
				await tx.insert(sessionEvents).values({
					sessionId: event.sessionId,
					runId: event.runId,
					level: event.level,
					code: event.code,
					message: event.message,
					data: event.data ?? null,
				});
				if (event.level === "error") {
					await tx
						.update(sessions)
						.set({ lastError: event.message })
						.where(eq(sessions.id, event.sessionId));
				}
			}
		}
	});

	// After commit: keep runtime stats and fan events out to SSE subscribers.
	for (const event of events) {
		if (event.type === "segment") {
			publish(`segments:${event.sessionId}`, event);
		} else if (event.type === "status") {
			recordStatus(event.sessionId, event.stats);
			publish(`status:${event.sessionId}`, event);
			publish("status:*", event);
		} else {
			publish("status:*", event);
		}
	}

	ensureWatchdog();
	return NextResponse.json({ accepted: events.length });
}
