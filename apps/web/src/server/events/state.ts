import type { z } from "zod";

import type { statsSchema } from "~/lib/contract";

export type SessionStats = z.infer<typeof statsSchema>;

/**
 * Latest runtime data per session: stats and receive time of the last
 * `status` event. Not persisted (see docs/domain-model.md); the events
 * endpoint updates it, the watchdog and the admin panel read it.
 */
const globalForState = globalThis as unknown as {
	sessionRuntime: Map<string, { stats: SessionStats; at: number }> | undefined;
};

function runtime(): Map<string, { stats: SessionStats; at: number }> {
	globalForState.sessionRuntime ??= new Map();
	return globalForState.sessionRuntime;
}

export function recordStatus(
	sessionId: string,
	stats: SessionStats,
	at = Date.now(),
): void {
	runtime().set(sessionId, { stats, at });
}

export function lastStatusAt(sessionId: string): number | undefined {
	return runtime().get(sessionId)?.at;
}

export function latestStats(sessionId: string): SessionStats | undefined {
	return runtime().get(sessionId)?.stats;
}
