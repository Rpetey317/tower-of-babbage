import {
	buildCues,
	type Cue,
	type ExportSegment,
	formatTimestamp,
	formatTxtTimestamp,
	mergeShortCues,
	splitLongCue,
	splitSentences,
	wrapCueText,
} from "./cues";
import { toSrt } from "./srt";
import { type TxtOptions, toTxt } from "./txt";
import { toVtt } from "./vtt";

export type ExportFormat = "srt" | "vtt" | "txt";

export interface ExportOptions extends TxtOptions {}

/**
 * Full transcript of one language and one run in the given format.
 * `segments` must be ordered by `chunkIndex`; cue rules come from
 * docs/components/export.md.
 */
export function renderExport(
	format: ExportFormat,
	segments: ExportSegment[],
	options: ExportOptions = {},
): string {
	const cues = buildCues(segments);
	switch (format) {
		case "srt":
			return toSrt(cues);
		case "vtt":
			return toVtt(cues);
		case "txt":
			return toTxt(cues, options);
	}
}

export {
	buildCues,
	type Cue,
	type ExportSegment,
	formatTimestamp,
	formatTxtTimestamp,
	mergeShortCues,
	splitLongCue,
	splitSentences,
	type TxtOptions,
	toSrt,
	toTxt,
	toVtt,
	wrapCueText,
};
