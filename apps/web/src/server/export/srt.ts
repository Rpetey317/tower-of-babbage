import { type Cue, formatTimestamp, wrapCueText } from "./cues";

/** SubRip serialization: numbered cues, `HH:MM:SS,mmm`, blank-line separated. */
export function toSrt(cues: Cue[]): string {
	if (cues.length === 0) return "";
	const blocks = cues.map(
		(cue, i) =>
			`${i + 1}\n${formatTimestamp(cue.startMs, ",")} --> ${formatTimestamp(cue.endMs, ",")}\n${wrapCueText(cue.text).join("\n")}`,
	);
	return `${blocks.join("\n\n")}\n`;
}
