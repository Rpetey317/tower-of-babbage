import type { Event } from "~/lib/contract";

export type CaptionSegment = Extract<Event, { type: "segment" }>;
export type CaptionStatus = Extract<Event, { type: "status" }>;
export type SessionStatus = CaptionStatus["status"];

/** One caption unit: the original plus one translation per language. */
export interface CaptionChunk {
	chunkIndex: number;
	original?: CaptionSegment;
	translations: Partial<Record<string, CaptionSegment>>;
}

export interface CaptionsState {
	/** Run the rendered chunks belong to; inferred from the first event seen. */
	runId: string | null;
	sessionStatus: SessionStatus | null;
	chunks: ReadonlyMap<number, CaptionChunk>;
	/** Set on run change; the view shows "session restarted" while empty. */
	restarted: boolean;
}

/** Chunks kept in memory; rendering slices the last N. */
export const maxChunks = 64;

export type CaptionsAction =
	| { type: "segment"; segment: CaptionSegment }
	| { type: "status"; status: CaptionStatus }
	| { type: "merge"; segments: CaptionSegment[] };

function upsertSegment(
	chunks: Map<number, CaptionChunk>,
	segment: CaptionSegment,
): Map<number, CaptionChunk> {
	const next = new Map(chunks);
	const entry = next.get(segment.chunkIndex) ?? {
		chunkIndex: segment.chunkIndex,
		translations: {},
	};
	if (segment.kind === "original") {
		entry.original = segment;
	} else {
		entry.translations[segment.language] = segment;
	}
	next.set(segment.chunkIndex, entry);
	return evict(next);
}

function evict(chunks: Map<number, CaptionChunk>): Map<number, CaptionChunk> {
	const overflow = chunks.size - maxChunks;
	if (overflow <= 0) return chunks;
	const oldest = [...chunks.keys()].sort((a, b) => a - b).slice(0, overflow);
	for (const key of oldest) chunks.delete(key);
	return chunks;
}

/** Initial state from the server-rendered `segments.recent` payload. */
export function createCaptionsState(opts: {
	segments?: CaptionSegment[];
	sessionStatus?: SessionStatus | null;
}): CaptionsState {
	const segments = opts.segments ?? [];
	let chunks = new Map<number, CaptionChunk>();
	for (const segment of segments) {
		chunks = upsertSegment(chunks, segment);
	}
	return {
		runId: segments[0]?.runId ?? null,
		sessionStatus: opts.sessionStatus ?? null,
		chunks,
		restarted: false,
	};
}

/**
 * Merges `segments.recent` backfill into the map: same upsert as live
 * segments, but never clears on run mismatch so a stale refetch cannot
 * clobber a newer run's chunks.
 */
function mergeSegments(
	state: CaptionsState,
	segments: CaptionSegment[],
): CaptionsState {
	const runId = state.runId ?? segments[0]?.runId ?? null;
	let chunks = new Map(state.chunks);
	for (const segment of segments) {
		if (runId !== null && segment.runId !== runId) continue;
		chunks = upsertSegment(chunks, segment);
	}
	return { ...state, runId, chunks };
}

export function captionsReducer(
	state: CaptionsState,
	action: CaptionsAction,
): CaptionsState {
	switch (action.type) {
		case "segment": {
			const segment = action.segment;
			if (state.runId !== null && segment.runId !== state.runId) {
				// First segment of a new run: clear and flag the restart.
				return {
					...state,
					runId: segment.runId,
					chunks: upsertSegment(new Map(), segment),
					restarted: true,
				};
			}
			return {
				...state,
				runId: state.runId ?? segment.runId,
				chunks: upsertSegment(new Map(state.chunks), segment),
			};
		}
		case "status": {
			const status = action.status;
			const runChanged = state.runId !== null && status.runId !== state.runId;
			return {
				...state,
				sessionStatus: status.status,
				runId: runChanged ? status.runId : (state.runId ?? status.runId),
				chunks: runChanged ? new Map() : state.chunks,
				restarted: state.restarted || runChanged,
			};
		}
		case "merge":
			return mergeSegments(state, action.segments);
	}
}

/** Chunk entries ordered by `chunkIndex`; the view renders the last N. */
export function sortedChunks(state: CaptionsState): CaptionChunk[] {
	return [...state.chunks.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
}

export type CaptionMode = "translation" | "original" | "both";

function isCaptionMode(value: string | undefined): value is CaptionMode {
	return value === "translation" || value === "original" || value === "both";
}

export interface CaptionViewParams {
	/** Language whose track the view renders (may be the source language). */
	language: string;
	mode: CaptionMode;
	/** `segments.recent`/`onSegment` input covering the active mode. */
	languages: string[];
}

/**
 * Resolves `/s/[slug]` query params per audience-web.md: `lang` must name the
 * source language or a declared target (default: first target); `mode`
 * defaults to `translation`.
 */
export function resolveCaptionView(opts: {
	sourceLanguage: string;
	targetLanguages: string[];
	lang?: string;
	mode?: string;
}): CaptionViewParams {
	const selectable = [opts.sourceLanguage, ...opts.targetLanguages];
	const language =
		opts.lang && selectable.includes(opts.lang)
			? opts.lang
			: (opts.targetLanguages[0] ?? opts.sourceLanguage);
	const mode = isCaptionMode(opts.mode) ? opts.mode : "translation";
	const languages =
		mode === "original"
			? [opts.sourceLanguage]
			: mode === "both"
				? [...new Set([opts.sourceLanguage, language])]
				: [language];
	return { language, mode, languages };
}

/** Text a chunk renders in the given mode, or `null` when still missing. */
export function chunkText(opts: {
	chunk: CaptionChunk;
	mode: CaptionMode;
	language: string;
	sourceLanguage: string;
}): { original?: string; translation?: string } {
	const { chunk, mode, language, sourceLanguage } = opts;
	if (mode === "original" || language === sourceLanguage) {
		return { original: chunk.original?.text };
	}
	const translation = chunk.translations[language]?.text;
	if (mode === "translation") return { translation };
	return { original: chunk.original?.text, translation };
}
