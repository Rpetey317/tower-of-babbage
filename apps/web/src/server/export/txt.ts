import { type Cue, formatTxtTimestamp } from "./cues";

export interface TxtOptions {
	/** Prefix each paragraph with `[HH:MM:SS]` (route flag `&timestamps=1`). */
	timestamps?: boolean;
}

/** Plain-text serialization: one paragraph per cue, no wrapping. */
export function toTxt(cues: Cue[], options: TxtOptions = {}): string {
	if (cues.length === 0) return "";
	const paragraphs = cues.map((cue) =>
		options.timestamps
			? `${formatTxtTimestamp(cue.startMs)} ${cue.text}`
			: cue.text,
	);
	return `${paragraphs.join("\n\n")}\n`;
}
