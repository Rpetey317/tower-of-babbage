import { describe, expect, it } from "vitest";

import {
	audioDriftMs,
	audioStalled,
	formatAudioMs,
	formatLatencyMs,
	hasDroppedChunks,
	latencyHigh,
	queueSaturated,
	type Stats,
} from "~/lib/admin/monitoring";

const stats: Stats = {
	audioReceivedMs: 60_000,
	chunksProcessed: 10,
	chunksDropped: 0,
	queueDepth: 0,
	latencyP50Ms: 2_000,
	latencyP95Ms: 3_000,
	lastError: null,
};

describe("audio drift", () => {
	const startedAt = new Date("2026-09-25T14:00:00.000Z");

	it("is null when the session never started", () => {
		expect(audioDriftMs(stats, null, Date.now())).toBeNull();
	});

	it("measures the gap between wall time and received audio", () => {
		const now = startedAt.getTime() + 75_000;
		expect(audioDriftMs(stats, startedAt, now)).toBe(15_000);
	});

	it("clamps negative drift when audio runs ahead of the clock", () => {
		const now = startedAt.getTime() + 30_000;
		expect(audioDriftMs(stats, startedAt, now)).toBe(0);
	});

	it("alarms only above the 10 s threshold", () => {
		const stalled = { ...stats, audioReceivedMs: 50_000 };
		const onTime = { ...stats, audioReceivedMs: 60_000 };
		expect(audioStalled(stalled, startedAt, startedAt.getTime() + 61_000)).toBe(
			true,
		);
		expect(audioStalled(onTime, startedAt, startedAt.getTime() + 70_000)).toBe(
			false,
		);
	});
});

describe("alarm predicates", () => {
	it("flags queue depth above 2", () => {
		expect(queueSaturated({ ...stats, queueDepth: 3 })).toBe(true);
		expect(queueSaturated({ ...stats, queueDepth: 2 })).toBe(false);
	});

	it("flags p95 latency above 10 s", () => {
		expect(latencyHigh({ ...stats, latencyP95Ms: 10_001 })).toBe(true);
		expect(latencyHigh({ ...stats, latencyP95Ms: 10_000 })).toBe(false);
	});

	it("flags any dropped chunks", () => {
		expect(hasDroppedChunks({ ...stats, chunksDropped: 1 })).toBe(true);
		expect(hasDroppedChunks(stats)).toBe(false);
	});
});

describe("formatters", () => {
	it("formats audio time as m:ss or h:mm:ss", () => {
		expect(formatAudioMs(0)).toBe("0:00");
		expect(formatAudioMs(78_400)).toBe("1:18");
		expect(formatAudioMs(3_723_000)).toBe("1:02:03");
	});

	it("formats latency in seconds", () => {
		expect(formatLatencyMs(2_140)).toBe("2.1 s");
		expect(formatLatencyMs(300)).toBe("0.3 s");
	});
});
