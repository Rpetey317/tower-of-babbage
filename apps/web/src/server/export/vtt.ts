import { type Cue, formatTimestamp, wrapCueText } from "./cues";

/** WebVTT serialization: `WEBVTT` header plus cues with `HH:MM:SS.mmm`. */
export function toVtt(cues: Cue[]): string {
	const blocks = cues.map(
		(cue) =>
			`${formatTimestamp(cue.startMs, ".")} --> ${formatTimestamp(cue.endMs, ".")}\n${wrapCueText(sanitizeVttText(cue.text)).join("\n")}`,
	);
	return ["WEBVTT", "", ...blocks, ""].join("\n");
}

/** `-->` is not allowed inside a VTT cue payload. */
function sanitizeVttText(text: string): string {
	return text.replaceAll("-->", "→");
}
