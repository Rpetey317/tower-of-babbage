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

export const deviceBackends = ["pulse", "alsa", "pipewire"] as const;

/**
 * Literal Tailwind classes per accent token so the scanner picks them up;
 * keyed by the `roomColors` entries above.
 */
export const roomColorClasses: Record<(typeof roomColors)[number], string> = {
	violet: "bg-violet",
	cyan: "bg-cyan",
	green: "bg-green",
	orange: "bg-orange",
	yellow: "bg-yellow",
	magenta: "bg-magenta",
	grey: "bg-grey",
};

/** `Gran Sala 2` -> `gran-sala-2`; empty result when nothing is usable. */
export function slugify(title: string): string {
	return title
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
