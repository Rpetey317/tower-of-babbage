import { beforeEach, describe, expect, it } from "vitest";

import type { Event } from "~/lib/contract";
import { createCaller } from "~/server/api/root";
import type { SegmentEvent, StatusEvent } from "~/server/api/routers/segments";
import {
	catchUpSegments,
	parseSegmentEventId,
	segmentEventId,
	statusEventId,
} from "~/server/api/routers/segments";
import { db } from "~/server/db";
import { segments, sessions } from "~/server/db/schema";
import { publish } from "~/server/events/bus";

const sessionId = "2d953063-05b4-4cac-9249-58c8b1b326a1";
const runId = "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";
const otherRunId = "8c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";

function caller() {
	return createCaller({ db, headers: new Headers() });
}

async function insertSession(
	overrides: Partial<typeof sessions.$inferInsert> = {},
) {
	await db.insert(sessions).values({
		id: sessionId,
		slug: "test-session",
		title: "Test session",
		sourceLanguage: "en",
		targetLanguages: ["es"],
		sourceType: "file_replay",
		...overrides,
	});
}

function segmentRow(overrides: Partial<typeof segments.$inferInsert> = {}) {
	return {
		sessionId,
		runId,
		chunkIndex: 0,
		kind: "original" as const,
		language: "en",
		text: "text",
		isFinal: true,
		startMs: 0,
		endMs: 1000,
		emittedAt: new Date("2026-09-25T14:03:12.345Z"),
		latencyMs: 100,
		...overrides,
	};
}

async function insertSegments(rows: Partial<typeof segments.$inferInsert>[]) {
	await db.insert(segments).values(rows.map((row) => segmentRow(row)));
}

async function take<T>(
	iterable: AsyncIterable<T>,
	count: number,
): Promise<T[]> {
	const iterator = iterable[Symbol.asyncIterator]();
	const items: T[] = [];
	try {
		for (let i = 0; i < count; i++) {
			const { done, value } = await iterator.next();
			if (done) break;
			items.push(value);
		}
	} finally {
		await iterator.return?.();
	}
	return items;
}

beforeEach(async () => {
	await db.delete(segments);
	await db.delete(sessions);
});

describe("event id encoding", () => {
	it("round-trips segment ids", () => {
		const id = segmentEventId({ runId, chunkIndex: 12, language: "es" });
		expect(id).toBe(`${runId}:12:es`);
		expect(parseSegmentEventId(id)).toEqual({ runId, chunkIndex: 12 });
	});

	it("parses status ids as replay-from-start of the run", () => {
		expect(parseSegmentEventId(statusEventId(runId))).toEqual({
			runId,
			chunkIndex: -1,
		});
	});

	it("rejects malformed ids", () => {
		expect(parseSegmentEventId("garbage")).toBeNull();
		expect(parseSegmentEventId(`${runId}:abc:en`)).toBeNull();
		expect(parseSegmentEventId(`${runId}:-1:en`)).toBeNull();
	});
});

describe("segments.recent", () => {
	it("returns the current run's segments for requested languages, in order", async () => {
		await insertSession({ currentRunId: runId });
		await insertSegments([
			{ chunkIndex: 0 },
			{ chunkIndex: 1 },
			{ chunkIndex: 1, language: "es", kind: "translation" },
			{ chunkIndex: 2, language: "pt" },
			{ chunkIndex: 9, runId: otherRunId },
		]);

		const result = await caller().segments.recent({
			sessionId,
			languages: ["en", "es"],
		});
		expect(result.map((s) => [s.chunkIndex, s.language])).toEqual([
			[0, "en"],
			[1, "en"],
			[1, "es"],
		]);
	});

	it("falls back to the latest run with segments when no run is current", async () => {
		await insertSession();
		await insertSegments([
			{ chunkIndex: 0, runId: otherRunId, emittedAt: new Date("2026-01-01") },
			{ chunkIndex: 5, emittedAt: new Date("2026-02-01") },
		]);
		const result = await caller().segments.recent({
			sessionId,
			languages: ["en"],
		});
		expect(result.map((s) => s.chunkIndex)).toEqual([5]);
	});

	it("honours limit by returning the latest chunks", async () => {
		await insertSession({ currentRunId: runId });
		await insertSegments([
			{ chunkIndex: 0 },
			{ chunkIndex: 1 },
			{ chunkIndex: 2 },
		]);
		const result = await caller().segments.recent({
			sessionId,
			languages: ["en"],
			limit: 2,
		});
		expect(result.map((s) => s.chunkIndex)).toEqual([1, 2]);
	});
});

describe("sessions.bySlug", () => {
	it("returns the session for a known slug", async () => {
		await insertSession();
		const session = await caller().sessions.bySlug({ slug: "test-session" });
		expect(session.slug).toBe("test-session");
	});

	it("throws NOT_FOUND for an unknown slug", async () => {
		await expect(
			caller().sessions.bySlug({ slug: "missing" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("catchUpSegments", () => {
	it("yields only segments after the given chunkIndex", async () => {
		await insertSession({ currentRunId: runId });
		await insertSegments([
			{ chunkIndex: 0 },
			{ chunkIndex: 1 },
			{ chunkIndex: 2 },
			{ chunkIndex: 3 },
			{ chunkIndex: 4 },
			{ chunkIndex: 3, runId: otherRunId },
		]);
		const missed = await catchUpSegments({
			sessionId,
			runId,
			afterChunkIndex: 2,
			languages: ["en"],
		});
		expect(missed.map((s) => s.chunkIndex)).toEqual([3, 4]);
	});
});

describe("segments.onSegment", () => {
	const segmentEvent: SegmentEvent = {
		type: "segment",
		sessionId,
		runId,
		chunkIndex: 7,
		kind: "original",
		language: "en",
		text: "live text",
		isFinal: true,
		startMs: 42000,
		endMs: 43000,
		emittedAt: "2026-09-25T14:03:12.345Z",
		latencyMs: 100,
	};

	it("replays missed segments from lastEventId before going live", async () => {
		await insertSession({ currentRunId: runId });
		await insertSegments([
			{ chunkIndex: 0 },
			{ chunkIndex: 1 },
			{ chunkIndex: 2 },
		]);

		const stream = (await caller().segments.onSegment({
			sessionId,
			languages: ["en"],
			lastEventId: segmentEventId({ runId, chunkIndex: 0, language: "en" }),
		})) as AsyncIterable<[string, Event, null]>;

		const items = await take(stream, 2);
		expect(
			items.map(([id, data]) => [id, (data as SegmentEvent).chunkIndex]),
		).toEqual([
			[`${runId}:1:en`, 1],
			[`${runId}:2:en`, 2],
		]);
	});

	it("forwards live segment and status events with tracked ids", async () => {
		await insertSession({ currentRunId: runId });

		const stream = (await caller().segments.onSegment({
			sessionId,
			languages: ["en"],
		})) as AsyncIterable<[string, Event, null]>;
		const iterator = stream[Symbol.asyncIterator]();

		// The generator attaches to the bus when first pulled; start it, then
		// give it a tick to subscribe before publishing.
		const firstPromise = iterator.next();
		await new Promise((resolve) => setTimeout(resolve, 10));

		publish(`segments:${sessionId}`, segmentEvent);
		publish(`segments:${sessionId}`, { ...segmentEvent, language: "pt" });
		const status: StatusEvent = {
			type: "status",
			sessionId,
			runId,
			status: "running",
			stats: {
				audioReceivedMs: 43000,
				chunksProcessed: 8,
				chunksDropped: 0,
				queueDepth: 0,
				latencyP50Ms: 90,
				latencyP95Ms: 120,
				lastError: null,
			},
			emittedAt: "2026-09-25T14:03:12.400Z",
		};
		publish(`status:${sessionId}`, status);

		const first = await firstPromise;
		expect(first.value[0]).toBe(`${runId}:7:en`);
		expect(first.value[1]).toEqual(segmentEvent);

		const second = await iterator.next();
		expect(second.value[0]).toBe(`${runId}:status`);
		expect(second.value[1]).toEqual(status);

		await iterator.return?.();
	});
});
