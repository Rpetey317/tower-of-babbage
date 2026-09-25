/** Option lists shared by the admin forms and the admin router. */

export const roomColors = [
	"violet",
	"cyan",
	"green",
	"orange",
	"yellow",
	"magenta",
	"grey",
] as const;

export const sourceTypes = [
	"browser_mic",
	"file_replay",
	"stream_url",
	"device",
] as const;

export const translationModes = ["ast", "asr_then_text"] as const;

export const languages = ["en", "es", "pt"] as const;

/** `Gran Sala 2` -> `gran-sala-2`; empty result when nothing is usable. */
export function slugify(title: string): string {
	return title
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
