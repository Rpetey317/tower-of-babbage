/**
 * Cue construction for transcript exports, implementing the rules in
 * docs/components/export.md. Pure functions: callers pass the segments of one
 * language and run ordered by `chunkIndex`.
 */

/** Minimal segment shape the exporters need; `segments` rows satisfy it. */
export interface ExportSegment {
	startMs: number;
	endMs: number;
	text: string;
}

export type Cue = ExportSegment;

export const maxCueDurationMs = 7_000;
export const minCueDurationMs = 800;
export const cueLineWidth = 42;
export const cueMaxLines = 2;

/** `HH:MM:SS<sep>mmm` where `sep` is `,` for SRT and `.` for VTT. */
export function formatTimestamp(ms: number, separator: "," | "."): string {
	const pad = (n: number, len = 2) => String(n).padStart(len, "0");
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor(ms / 60_000) % 60;
	const s = Math.floor(ms / 1_000) % 60;
	return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1_000, 3)}`;
}

/** `[HH:MM:SS]` used by the TXT `timestamps` option. */
export function formatTxtTimestamp(ms: number): string {
	return `[${formatTimestamp(ms, ",").slice(0, 8)}]`;
}

/**
 * Sentence split points: whitespace following `.`, `!`, `?` or `…`, allowing
 * closing quotes or brackets in between (`"Done." Next` still splits).
 */
const sentenceBoundary = /[.!?…]+["'»)\]]*\s+/g;

export function splitSentences(text: string): string[] {
	const parts: string[] = [];
	let last = 0;
	for (const match of text.matchAll(sentenceBoundary)) {
		const end = (match.index ?? 0) + match[0].length;
		parts.push(text.slice(last, end).trim());
		last = end;
	}
	parts.push(text.slice(last).trim());
	return parts.filter((part) => part.length > 0);
}

/**
 * A cue longer than `maxCueDurationMs` is split at sentence boundaries into
 * contiguous sub-cues whose share of the cue duration is proportional to each
 * part's character count. A long cue without sentence boundaries stays whole.
 */
export function splitLongCue(cue: Cue): Cue[] {
	if (cue.endMs - cue.startMs <= maxCueDurationMs) return [cue];
	const parts = splitSentences(cue.text);
	if (parts.length <= 1) return [cue];

	const totalChars = parts.reduce((sum, part) => sum + part.length, 0);
	const duration = cue.endMs - cue.startMs;
	const cues: Cue[] = [];
	let chars = 0;
	let startMs = cue.startMs;
	for (const [i, part] of parts.entries()) {
		chars += part.length;
		const endMs =
			i === parts.length - 1
				? cue.endMs
				: cue.startMs + Math.round((duration * chars) / totalChars);
		cues.push({ startMs, endMs, text: part });
		startMs = endMs;
	}
	return cues;
}

/**
 * Cues shorter than `minCueDurationMs` merge into the following cue. A short
 * cue at the end merges into the previous one instead; a lone cue stays.
 */
export function mergeShortCues(cues: Cue[]): Cue[] {
	const out: Cue[] = [];
	let pending: Cue | null = null;
	for (const cue of cues) {
		const current: Cue = pending
			? {
					startMs: pending.startMs,
					endMs: cue.endMs,
					text: `${pending.text} ${cue.text}`,
				}
			: cue;
		pending = null;
		if (current.endMs - current.startMs < minCueDurationMs) {
			pending = current;
		} else {
			out.push(current);
		}
	}
	if (pending) {
		const last = out.at(-1);
		if (last) {
			out[out.length - 1] = {
				startMs: last.startMs,
				endMs: pending.endMs,
				text: `${last.text} ${pending.text}`,
			};
		} else {
			out.push(pending);
		}
	}
	return out;
}

/**
 * Segments to cues: drop empty text, split long cues, merge short ones.
 * Chunk gaps are preserved; overlaps are impossible by construction.
 */
export function buildCues(segments: ExportSegment[]): Cue[] {
	const cues = segments
		.map((segment) => ({
			startMs: segment.startMs,
			endMs: segment.endMs,
			text: segment.text.trim(),
		}))
		.filter((cue) => cue.text.length > 0);
	return mergeShortCues(cues.flatMap(splitLongCue));
}

/**
 * Greedy word wrap at `width` characters, at most `maxLines` lines. If the
 * text still does not fit, the remainder stays on the last line rather than
 * dropping or inventing extra cue time.
 */
export function wrapCueText(
	text: string,
	width = cueLineWidth,
	maxLines = cueMaxLines,
): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (line === "") {
			line = word;
		} else if (line.length + 1 + word.length <= width) {
			line = `${line} ${word}`;
		} else {
			lines.push(line);
			line = word;
		}
	}
	if (line) lines.push(line);
	if (lines.length > maxLines) {
		return [
			...lines.slice(0, maxLines - 1),
			lines.slice(maxLines - 1).join(" "),
		];
	}
	return lines;
}
