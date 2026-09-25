import { describe, expect, it } from "vitest";

import {
	type CaptionSegment,
	type CaptionStatus,
	captionsReducer,
	chunkSpeaker,
	chunkText,
	createCaptionsState,
	maxChunks,
	resolveCaptionView,
	sortedChunks,
} from "./captions";

const sessionId = "2d953063-05b4-4cac-9249-58c8b1b326a1";
const runId = "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";
const nextRunId = "8c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";

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

function status(overrides: Partial<CaptionStatus> = {}): CaptionStatus {
	return {
		type: "status",
		sessionId,
		runId,
		status: "running",
		stats: {
			audioReceivedMs: 0,
			chunksProcessed: 0,
			chunksDropped: 0,
			queueDepth: 0,
			latencyP50Ms: 0,
			latencyP95Ms: 0,
			lastError: null,
		},
		emittedAt: "2026-09-25T14:03:12.400Z",
		...overrides,
	};
}

function indexes(state: ReturnType<typeof createCaptionsState>) {
	return sortedChunks(state).map((c) => c.chunkIndex);
}

describe("createCaptionsState", () => {
	it("merges original and translation rows into one chunk", () => {
		const state = createCaptionsState({
			segments: [
				segment({ chunkIndex: 1 }),
				segment({ chunkIndex: 0 }),
				segment({
					chunkIndex: 1,
					kind: "translation",
					language: "es",
					text: "texto",
				}),
			],
		});
		expect(indexes(state)).toEqual([0, 1]);
		const chunk = state.chunks.get(1);
		expect(chunk?.original?.text).toBe("text");
		expect(chunk?.translations.es?.text).toBe("texto");
		expect(state.runId).toBe(runId);
	});

	it("infers no run when there are no segments", () => {
		const state = createCaptionsState({ segments: [] });
		expect(state.runId).toBeNull();
	});
});

describe("captionsReducer: segment", () => {
	it("places out-of-order chunks by chunkIndex", () => {
		let state = createCaptionsState({});
		state = captionsReducer(state, {
			type: "segment",
			segment: segment({ chunkIndex: 5 }),
		});
		state = captionsReducer(state, {
			type: "segment",
			segment: segment({ chunkIndex: 3 }),
		});
		expect(indexes(state)).toEqual([3, 5]);
	});

	it("fills a late translation beside its original", () => {
		let state = createCaptionsState({
			segments: [segment({ chunkIndex: 2 })],
		});
		state = captionsReducer(state, {
			type: "segment",
			segment: segment({
				chunkIndex: 2,
				kind: "translation",
				language: "es",
				text: "tarde",
			}),
		});
		expect(state.chunks.get(2)?.translations.es?.text).toBe("tarde");
	});

	it("replaces the text of a duplicate segment", () => {
		let state = createCaptionsState({
			segments: [segment({ chunkIndex: 0, text: "viejo" })],
		});
		state = captionsReducer(state, {
			type: "segment",
			segment: segment({ chunkIndex: 0, text: "nuevo" }),
		});
		expect(state.chunks.get(0)?.original?.text).toBe("nuevo");
	});

	it("clears chunks and flags the restart on a new runId", () => {
		let state = createCaptionsState({
			segments: [segment({ chunkIndex: 0 }), segment({ chunkIndex: 1 })],
		});
		state = captionsReducer(state, {
			type: "segment",
			segment: segment({ runId: nextRunId, chunkIndex: 0 }),
		});
		expect(indexes(state)).toEqual([0]);
		expect(state.runId).toBe(nextRunId);
		expect(state.restarted).toBe(true);
	});

	it("evicts chunks beyond maxChunks, keeping the newest", () => {
		let state = createCaptionsState({
			segments: Array.from({ length: maxChunks + 3 }, (_, i) =>
				segment({ chunkIndex: i }),
			),
		});
		state = captionsReducer(state, {
			type: "segment",
			segment: segment({ chunkIndex: maxChunks + 3 }),
		});
		expect(state.chunks.size).toBe(maxChunks);
		expect(indexes(state)[0]).toBe(4);
	});
});

describe("captionsReducer: status", () => {
	it("updates the session status without touching chunks", () => {
		let state = createCaptionsState({
			segments: [segment({ chunkIndex: 0 })],
		});
		state = captionsReducer(state, {
			type: "status",
			status: status({ status: "idle" }),
		});
		expect(state.sessionStatus).toBe("idle");
		expect(indexes(state)).toEqual([0]);
		expect(state.restarted).toBe(false);
	});

	it("clears chunks and flags the restart on a new runId", () => {
		let state = createCaptionsState({
			segments: [segment({ chunkIndex: 0 })],
		});
		state = captionsReducer(state, {
			type: "status",
			status: status({ runId: nextRunId, status: "starting" }),
		});
		expect(state.runId).toBe(nextRunId);
		expect(state.sessionStatus).toBe("starting");
		expect(state.chunks.size).toBe(0);
		expect(state.restarted).toBe(true);
	});

	it("adopts the runId on the first status seen", () => {
		let state = createCaptionsState({});
		state = captionsReducer(state, { type: "status", status: status() });
		expect(state.runId).toBe(runId);
		expect(state.restarted).toBe(false);
	});
});

describe("captionsReducer: merge", () => {
	it("upserts backfill segments and keeps existing chunks", () => {
		let state = createCaptionsState({
			segments: [segment({ chunkIndex: 5 })],
		});
		state = captionsReducer(state, {
			type: "merge",
			segments: [
				segment({ chunkIndex: 3 }),
				segment({
					chunkIndex: 5,
					kind: "translation",
					language: "es",
					text: "relleno",
				}),
			],
		});
		expect(indexes(state)).toEqual([3, 5]);
		expect(state.chunks.get(5)?.translations.es?.text).toBe("relleno");
	});

	it("ignores segments from a stale run", () => {
		let state = createCaptionsState({
			segments: [segment({ chunkIndex: 5, runId: nextRunId })],
		});
		state = captionsReducer(state, {
			type: "merge",
			segments: [segment({ chunkIndex: 9 })],
		});
		expect(indexes(state)).toEqual([5]);
		expect(state.runId).toBe(nextRunId);
	});
});

describe("resolveCaptionView", () => {
	const base = { sourceLanguage: "en", targetLanguages: ["es", "pt"] };

	it("defaults to the first target language in translation mode", () => {
		expect(resolveCaptionView(base)).toEqual({
			language: "es",
			mode: "translation",
			languages: ["es"],
		});
	});

	it("rejects an undeclared lang and an unknown mode", () => {
		expect(resolveCaptionView({ ...base, lang: "fr", mode: "bogus" })).toEqual({
			language: "es",
			mode: "translation",
			languages: ["es"],
		});
	});

	it("subscribes to the source language only in original mode", () => {
		expect(resolveCaptionView({ ...base, mode: "original" })).toEqual({
			language: "es",
			mode: "original",
			languages: ["en"],
		});
	});

	it("covers source and target in both mode, deduplicated", () => {
		expect(
			resolveCaptionView({ ...base, lang: "pt", mode: "both" }).languages,
		).toEqual(["en", "pt"]);
		expect(
			resolveCaptionView({ ...base, lang: "en", mode: "both" }).languages,
		).toEqual(["en"]);
	});

	it("accepts the source language as lang", () => {
		expect(resolveCaptionView({ ...base, lang: "en" }).languages).toEqual([
			"en",
		]);
	});
});

describe("chunkSpeaker", () => {
	it("shares the speaker across original and translations", () => {
		const chunk = {
			chunkIndex: 0,
			original: segment({ speaker: "S1" }),
			translations: {
				es: segment({ kind: "translation", language: "es", speaker: "S1" }),
			},
		};
		expect(chunkSpeaker(chunk)).toBe("S1");
	});

	it("falls back to the translation and stays undefined when unattributed", () => {
		expect(
			chunkSpeaker({
				chunkIndex: 0,
				translations: {
					es: segment({ kind: "translation", language: "es", speaker: "S2" }),
				},
			}),
		).toBe("S2");
		expect(
			chunkSpeaker({
				chunkIndex: 0,
				original: segment(),
				translations: {},
			}),
		).toBeUndefined();
	});
});

describe("chunkText", () => {
	const chunk = {
		chunkIndex: 0,
		original: segment({ text: "hello" }),
		translations: {
			es: segment({ kind: "translation", language: "es", text: "hola" }),
		},
	};

	it("returns the selected translation in translation mode", () => {
		expect(
			chunkText({
				chunk,
				mode: "translation",
				language: "es",
				sourceLanguage: "en",
			}),
		).toEqual({ translation: "hola" });
	});

	it("returns the original when lang names the source language", () => {
		expect(
			chunkText({
				chunk,
				mode: "translation",
				language: "en",
				sourceLanguage: "en",
			}),
		).toEqual({ original: "hello" });
	});

	it("returns both tracks in both mode", () => {
		expect(
			chunkText({
				chunk,
				mode: "both",
				language: "es",
				sourceLanguage: "en",
			}),
		).toEqual({ original: "hello", translation: "hola" });
	});

	it("reports missing tracks instead of inventing them", () => {
		expect(
			chunkText({
				chunk: { chunkIndex: 0, translations: {} },
				mode: "both",
				language: "es",
				sourceLanguage: "en",
			}),
		).toEqual({ original: undefined, translation: undefined });
	});
});
