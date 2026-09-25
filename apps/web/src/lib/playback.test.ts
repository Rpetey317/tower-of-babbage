import { describe, expect, it } from "vitest";

import type { CaptionChunk, CaptionSegment } from "./captions";
import {
	cueAt,
	cueLingerMs,
	isSafeRelativePath,
	parseRange,
	videoExtension,
	videoMediaPath,
} from "./playback";

const sessionId = "2d953063-05b4-4cac-9249-58c8b1b326a1";
const runId = "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";

function segment(overrides: Partial<CaptionSegment> = {}): CaptionSegment {
	return {
		type: "segment",
		sessionId,
		runId,
		chunkIndex: 0,
		kind: "original",
		language: "en",
		text: "text",
		isFinal: true,
		startMs: 0,
		endMs: 1000,
		emittedAt: "2026-09-25T14:03:12.345Z",
		latencyMs: 100,
		...overrides,
	};
}

function chunk(
	chunkIndex: number,
	startMs: number,
	endMs: number,
	translations: CaptionSegment[] = [],
): CaptionChunk {
	return {
		chunkIndex,
		original: segment({ chunkIndex, startMs, endMs }),
		translations: Object.fromEntries(
			translations.map((segment) => [segment.language, segment]),
		),
	};
}

// Chunks of a short replay: speech 0-5 s, a pause longer than the linger,
// speech 8-11 s.
const chunks = [
	chunk(0, 0, 5_000, [
		segment({
			chunkIndex: 0,
			kind: "translation",
			language: "es",
			startMs: 0,
			endMs: 5_000,
		}),
	]),
	chunk(1, 8_000, 11_000),
];

describe("cueAt", () => {
	it("returns the chunk whose window covers the time", () => {
		expect(cueAt(chunks, 0)?.chunkIndex).toBe(0);
		expect(cueAt(chunks, 4_999)?.chunkIndex).toBe(0);
		expect(cueAt(chunks, 8_000)?.chunkIndex).toBe(1);
		expect(cueAt(chunks, 10_999)?.chunkIndex).toBe(1);
	});

	it("returns null before the first cue", () => {
		expect(cueAt(chunks, -1)).toBeNull();
		expect(cueAt([], 1_000)).toBeNull();
	});

	it("holds the cue through the linger after its window", () => {
		expect(cueAt(chunks, 5_000)?.chunkIndex).toBe(0);
		expect(cueAt(chunks, 5_000 + cueLingerMs - 1)?.chunkIndex).toBe(0);
	});

	it("returns null in a silence gap longer than the linger", () => {
		expect(cueAt(chunks, 5_000 + cueLingerMs)).toBeNull();
		expect(cueAt(chunks, 7_999)).toBeNull();
	});

	it("picks the earlier chunk again after seeking backwards", () => {
		expect(cueAt(chunks, 30_000)).toBeNull();
		expect(cueAt(chunks, 2_000)?.chunkIndex).toBe(0);
	});

	it("times a chunk from its translation when no original is loaded", () => {
		const translationOnly: CaptionChunk = {
			chunkIndex: 0,
			translations: {
				es: segment({
					kind: "translation",
					language: "es",
					startMs: 2_000,
					endMs: 4_000,
				}),
			},
		};
		expect(cueAt([translationOnly], 1_000)).toBeNull();
		expect(cueAt([translationOnly], 3_000)?.chunkIndex).toBe(0);
	});
});

describe("parseRange", () => {
	it("returns null without a Range header", () => {
		expect(parseRange(null, 1_000)).toBeNull();
	});

	it("parses closed and open-ended ranges, clamping to size", () => {
		expect(parseRange("bytes=0-99", 1_000)).toEqual({ start: 0, end: 99 });
		expect(parseRange("bytes=500-", 1_000)).toEqual({ start: 500, end: 999 });
		expect(parseRange("bytes=990-9999", 1_000)).toEqual({
			start: 990,
			end: 999,
		});
	});

	it("parses a suffix range as the last N bytes", () => {
		expect(parseRange("bytes=-100", 1_000)).toEqual({ start: 900, end: 999 });
		expect(parseRange("bytes=-5000", 1_000)).toEqual({ start: 0, end: 999 });
	});

	it("rejects malformed or unsatisfiable ranges", () => {
		expect(parseRange("bytes=1000-", 1_000)).toBe("invalid");
		expect(parseRange("bytes=500-100", 1_000)).toBe("invalid");
		expect(parseRange("bytes=-", 1_000)).toBe("invalid");
		expect(parseRange("bytes=-0", 1_000)).toBe("invalid");
		expect(parseRange("items=0-10", 1_000)).toBe("invalid");
		expect(parseRange("bytes=0-10,20-30", 1_000)).toBe("invalid");
	});
});

describe("isSafeRelativePath", () => {
	it("accepts plain relative paths", () => {
		expect(isSafeRelativePath("en-kubernetes-60s.mp4")).toBe(true);
		expect(isSafeRelativePath("subdir/file.mp4")).toBe(true);
	});

	it("rejects absolute paths, traversal and separators", () => {
		expect(isSafeRelativePath("/etc/passwd")).toBe(false);
		expect(isSafeRelativePath("../outside.mp4")).toBe(false);
		expect(isSafeRelativePath("sub/../../outside.mp4")).toBe(false);
		expect(isSafeRelativePath("C:\\video.mp4")).toBe(false);
		expect(isSafeRelativePath("dir\\file.mp4")).toBe(false);
		expect(isSafeRelativePath("")).toBe(false);
	});
});

describe("videoExtension", () => {
	it("recognizes playable containers case-insensitively", () => {
		expect(videoExtension("talk.MP4")).toBe("mp4");
		expect(videoExtension("talk.webm")).toBe("webm");
	});

	it("returns null for audio or extensionless files", () => {
		expect(videoExtension("talk.wav")).toBeNull();
		expect(videoExtension("noext")).toBeNull();
	});
});

describe("videoMediaPath", () => {
	const session = (sourceType: string, sourceConfig: unknown) => ({
		sourceType,
		sourceConfig,
	});

	it("returns the path of a video file_replay source", () => {
		expect(
			videoMediaPath(
				session("file_replay", { path: "en-kubernetes-60s.mp4", loop: false }),
			),
		).toBe("en-kubernetes-60s.mp4");
	});

	it("returns null for other source types", () => {
		expect(videoMediaPath(session("browser_mic", {}))).toBeNull();
		expect(videoMediaPath(session("stream_url", { url: "x" }))).toBeNull();
	});

	it("returns null for audio replays and unsafe paths", () => {
		expect(
			videoMediaPath(
				session("file_replay", { path: "en-kubernetes-60s.wav", loop: false }),
			),
		).toBeNull();
		expect(
			videoMediaPath(
				session("file_replay", { path: "../secrets.mp4", loop: false }),
			),
		).toBeNull();
	});

	it("returns null on a malformed config", () => {
		expect(videoMediaPath(session("file_replay", { path: 42 }))).toBeNull();
		expect(videoMediaPath(session("file_replay", null))).toBeNull();
	});
});
