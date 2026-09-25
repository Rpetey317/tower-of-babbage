import { type CaptionMode, resolveCaptionView } from "~/lib/captions";

export type OverlayAlign = "bottom" | "top";
export type OverlayBackground = "band" | "box" | "none";

export interface OverlayParams {
	language: string;
	mode: CaptionMode;
	/** Language tracks the subscription/backfill must cover. */
	languages: string[];
	/** Maximum visible lines after wrapping at the current width. */
	lines: number;
	/** Font size in px at 1080p; the view scales it with viewport width. */
	size: number;
	align: OverlayAlign;
	bg: OverlayBackground;
	/** Safe-area margin in px at 1080p, scaled like `size`. */
	margin: number;
	fade: boolean;
}

const defaults = {
	lines: 2,
	size: 48,
	margin: 64,
} as const;

const bounds = {
	lines: { min: 1, max: 8 },
	size: { min: 12, max: 192 },
	margin: { min: 0, max: 400 },
} as const;

type Query = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function intParam(
	value: string | undefined,
	fallback: number,
	{ min, max }: { min: number; max: number },
): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * Resolves `/overlay/[slug]` search params per obs-overlay.md. `lang`/`mode`
 * follow the audience rules (`resolveCaptionView`); every other param falls
 * back to its documented default so a typo never breaks a running stream.
 */
export function resolveOverlayParams(opts: {
	query: Query;
	sourceLanguage: string;
	targetLanguages: string[];
}): OverlayParams {
	const view = resolveCaptionView({
		sourceLanguage: opts.sourceLanguage,
		targetLanguages: opts.targetLanguages,
		lang: first(opts.query.lang),
		mode: first(opts.query.mode),
	});
	const bg = first(opts.query.bg);
	return {
		language: view.language,
		mode: view.mode,
		languages: view.languages,
		lines: intParam(first(opts.query.lines), defaults.lines, bounds.lines),
		size: intParam(first(opts.query.size), defaults.size, bounds.size),
		align: first(opts.query.align) === "top" ? "top" : "bottom",
		bg: bg === "box" || bg === "none" ? bg : "band",
		margin: intParam(first(opts.query.margin), defaults.margin, bounds.margin),
		fade: first(opts.query.anim) === "fade",
	};
}
