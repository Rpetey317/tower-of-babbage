import { inArray } from "drizzle-orm";

import { db } from "~/server/db";
import { sessionEvents, sessions } from "~/server/db/schema";

import { publish } from "./bus";
import { lastStatusAt, latestStats } from "./state";

const staleAfterMs = 15_000;
const sweepIntervalMs = 5_000;

const globalForWatchdog = globalThis as unknown as {
	eventWatchdog: NodeJS.Timeout | undefined;
};

/**
 * Marks `running`/`starting` sessions `error` with code `status_timeout` when
 * no `status` event arrived for `staleAfterMs`. Staleness is measured from the
 * last status event this process applied, falling back to `sessions.updatedAt`
 * (e.g. right after a restart, when the in-memory map is empty).
 */
export async function sweepStaleSessions(now = Date.now()): Promise<void> {
	const active = await db
		.select({
			id: sessions.id,
			currentRunId: sessions.currentRunId,
			updatedAt: sessions.updatedAt,
		})
		.from(sessions)
		.where(inArray(sessions.status, ["starting", "running"]));

	const stale = active.filter(
		(row) =>
			now - (lastStatusAt(row.id) ?? row.updatedAt.getTime()) > staleAfterMs,
	);
	if (stale.length === 0) return;

	await db.transaction(async (tx) => {
		await tx
			.update(sessions)
			.set({ status: "error", lastError: "status_timeout" })
			.where(
				inArray(
					sessions.id,
					stale.map((row) => row.id),
				),
			);
		await tx.insert(sessionEvents).values(
			stale.map((row) => ({
				sessionId: row.id,
				runId: row.currentRunId,
				level: "error" as const,
				code: "status_timeout",
				message: "No status event received for 15 s",
			})),
		);
	});

	const emittedAt = new Date(now).toISOString();
	for (const row of stale) {
		const event = {
			type: "status" as const,
			sessionId: row.id,
			runId: row.currentRunId ?? "00000000-0000-0000-0000-000000000000",
			status: "error" as const,
			stats: latestStats(row.id) ?? {
				audioReceivedMs: 0,
				chunksProcessed: 0,
				chunksDropped: 0,
				queueDepth: 0,
				latencyP50Ms: 0,
				latencyP95Ms: 0,
				lastError: "status_timeout",
			},
			emittedAt,
		};
		publish(`status:${row.id}`, event);
		publish("status:*", event);
	}
}

/** Starts the 5 s interval lazily; one interval per process via `globalThis`. */
export function ensureWatchdog(): void {
	globalForWatchdog.eventWatchdog ??= setInterval(() => {
		sweepStaleSessions().catch(() => {
			// A failed sweep retries on the next tick.
		});
	}, sweepIntervalMs);
	globalForWatchdog.eventWatchdog.unref();
}
