/**
 * Speaker attribution for captions (contract v2): each segment may carry a
 * label like "S1" that identifies the voice the provider heard in the chunk.
 * The view colors each speaker with a branding accent token (see
 * docs/branding.md); `coral` stays reserved for errors and `grey` for
 * unattributed content.
 */
export const speakerAccents = [
	"cyan",
	"violet",
	"green",
	"orange",
	"magenta",
	"yellow",
] as const;
export type SpeakerAccent = (typeof speakerAccents)[number];

// Literal class strings keep Tailwind's scanner aware of the accent names.
const accentClasses: Record<SpeakerAccent, string> = {
	cyan: "text-cyan",
	violet: "text-violet",
	green: "text-green",
	orange: "text-orange",
	magenta: "text-magenta",
	yellow: "text-yellow",
};

const speakerTag = /^S(\d+)$/;

function accentAt(index: number): SpeakerAccent {
	return (
		speakerAccents[Math.abs(index) % speakerAccents.length] ?? speakerAccents[0]
	);
}

/**
 * Maps a speaker label to a palette accent, deterministically: numbered
 * labels cycle the palette in order (`S1` -> first accent) and any other
 * label falls back to a stable character-code hash.
 */
export function speakerAccent(speaker: string): SpeakerAccent {
	const tagged = speakerTag.exec(speaker);
	if (tagged?.[1] !== undefined) {
		return accentAt(Number(tagged[1]) - 1);
	}
	let hash = 0;
	for (let i = 0; i < speaker.length; i++) {
		hash = (hash * 31 + speaker.charCodeAt(i)) | 0;
	}
	return accentAt(hash);
}

/** Tailwind text-color class for the speaker's accent. */
export function speakerTextClass(speaker: string): string {
	return accentClasses[speakerAccent(speaker)];
}

/**
 * Display name for the label through the locale template (`{n}` is the
 * speaker number). Labels that are not `S<n>` render as-is.
 */
export function speakerName(speaker: string, label: string): string {
	const number = speakerTag.exec(speaker)?.[1];
	return number !== undefined ? label.replace("{n}", number) : speaker;
}
