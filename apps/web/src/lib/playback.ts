import { z } from "zod";

import type { CaptionChunk } from "~/lib/captions";

/**
 * Playback helpers for `/s/[slug]/play` and `GET /api/media/[slug]`
 * (docs/components/playback.md). No Node imports: this file is also bundled
 * into the client component, so path containment that needs `node:path`
 * lives in the route.
 */

/** Browser-playable container extension -> Content-Type. */
export const videoMime: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
};

const fileReplayConfig = z
	.object({ path: z.string(), loop: z.boolean() })
	.strict();

/**
 * Rejects anything that is not a plain relative path: absolute paths,
 * Windows drives and separators, NUL bytes and `..` segments. The media
 * route re-checks containment after resolving; this is the cheap gate.
 */
export function isSafeRelativePath(path: string): boolean {
	if (path === "" || path.includes("\0") || path.includes("\\")) return false;
	if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
	return !path.split("/").includes("..");
}

/** Lowercase extension when it maps to a playable video type. */
export function videoExtension(path: string): string | null {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return null;
	const ext = path.slice(dot + 1).toLowerCase();
	return ext in videoMime ? ext : null;
}

/**
 * The media file a session replays, or `null` when the session has no
 * playable video (not `file_replay`, malformed config, unsafe path or a
 * non-video file such as a WAV fixture).
 */
export function videoMediaPath(session: {
	sourceType: string;
	sourceConfig: unknown;
}): string | null {
	if (session.sourceType !== "file_replay") return null;
	const parsed = fileReplayConfig.safeParse(session.sourceConfig);
	if (!parsed.success) return null;
	const path = parsed.data.path;
	if (!isSafeRelativePath(path) || videoExtension(path) === null) return null;
	return path;
}

export interface ByteRange {
	start: number;
	end: number;
}

/**
 * Parses a single `Range: bytes=start-end` header against `size`. Returns
 * `null` when no range was requested, `"invalid"` when the header is
 * malformed or unsatisfiable (the route answers 416). Multi-range headers
 * are rejected rather than served as multipart.
 */
export function parseRange(
	header: string | null,
	size: number,
): ByteRange | null | "invalid" {
	if (header === null) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match || (match[1] === "" && match[2] === "")) return "invalid";
	if (match[1] === "") {
		const suffix = Number(match[2]);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(match[1]);
	const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	if (!Number.isSafeInteger(start) || start > end || start >= size) {
		return "invalid";
	}
	return { start, end };
}

/**
 * How long a cue stays on screen after its window closes. Translations are
 * emitted after their chunk's audio window ends (provider latency), so a
 * cue that disappeared exactly at `endMs` would never show late text to a
 * viewer tracking live media time.
 */
export const cueLingerMs = 2_000;

function chunkTiming(
	chunk: CaptionChunk,
): { startMs: number; endMs: number } | null {
	const segment = chunk.original ?? Object.values(chunk.translations)[0];
	return segment ? { startMs: segment.startMs, endMs: segment.endMs } : null;
}

/**
 * The chunk on screen at `timeMs` of playback: the latest one whose window
 * already started, held until `endMs + cueLingerMs` so pauses inside a
 * chunk's tail and late-arriving translations still render. Returns `null`
 * in silence gaps and before the first cue.
 */
export function cueAt(
	chunks: readonly CaptionChunk[],
	timeMs: number,
): CaptionChunk | null {
	let best: CaptionChunk | null = null;
	let bestStart = -1;
	for (const chunk of chunks) {
		const timing = chunkTiming(chunk);
		if (timing === null || timing.startMs > timeMs) continue;
		if (timing.startMs >= bestStart) {
			best = chunk;
			bestStart = timing.startMs;
		}
	}
	if (best === null) return null;
	const timing = chunkTiming(best);
	if (timing === null || timeMs >= timing.endMs + cueLingerMs) return null;
	return best;
}
