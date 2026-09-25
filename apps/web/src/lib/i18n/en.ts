import type { es } from "./es";

export const en = {
	liveBadge: "LIVE",
	notLiveBadge: "Not live",
	noRoom: "No room",
	backToSessions: "All sessions",
	captionLangLabel: "Caption language",
	modeLabel: "Mode",
	modeTranslation: "Translation",
	modeOriginal: "Original",
	modeBoth: "Both",
	fontSizeLabel: "Text size",
	fontSizeDecrease: "Decrease text size",
	fontSizeIncrease: "Increase text size",
	connLive: "LIVE",
	connReconnecting: "Reconnecting…",
	connNotLive: "Not live",
	sessionRestarted: "Session restarted.",
	waitingForCaptions: "Waiting for captions…",
	jumpToLive: "Jump to live",

	homeHeading: "Sessions",
	emptySessions: "Sessions will appear here.",
	localeLabel: "Interface language",
	siteDescription: "Live captions and translation for conferences.",
} satisfies Record<keyof typeof es, string>;
