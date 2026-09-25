import type { z } from "zod";

import type { statsSchema } from "~/lib/contract";

export type Stats = z.infer<typeof statsSchema>;

const audioStallThresholdMs = 10_000;
const queueAlarmDepth = 2;
const latencyAlarmMs = 10_000;

/**
 * How far the audio clock lags the wall clock since the run started. Negative
 * drift (a replay running ahead of real time) clamps to zero: only a stalled
 * producer matters. `null` when the session was never started.
 */
export function audioDriftMs(
	stats: Stats,
	startedAt: Date | null,
	now: number,
): number | null {
	if (!startedAt) return null;
	return Math.max(0, now - startedAt.getTime() - stats.audioReceivedMs);
}

/** admin-panel.md: audio drift above 10 s means the producer is stalling. */
export function audioStalled(
	stats: Stats,
	startedAt: Date | null,
	now: number,
): boolean {
	const drift = audioDriftMs(stats, startedAt, now);
	return drift !== null && drift > audioStallThresholdMs;
}

/**
 * admin-panel.md: queue above 2 sustained means inference is too slow. Each
 * stats sample already spans seconds (status events arrive every few
 * seconds), so the current depth alone signals sustained saturation.
 */
export function queueSaturated(stats: Stats): boolean {
	return stats.queueDepth > queueAlarmDepth;
}

export function latencyHigh(stats: Stats): boolean {
	return stats.latencyP95Ms > latencyAlarmMs;
}

export function hasDroppedChunks(stats: Stats): boolean {
	return stats.chunksDropped > 0;
}

/** `78400` -> `"1:18"`, `3723000` -> `"1:02:03"`. */
export function formatAudioMs(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	const mmss = `${minutes}:${String(seconds).padStart(2, "0")}`;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
		: mmss;
}

/** `2140` -> `"2.1 s"`. */
export function formatLatencyMs(ms: number): string {
	return `${(ms / 1000).toFixed(1)} s`;
}
