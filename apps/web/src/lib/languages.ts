/**
 * Caption languages a session may use, mirroring the pipeline's table in
 * `services/pipeline/internal/provider/languages.go` — adding a language is
 * one row there and one entry here (docs/components/languages.md). `verified`
 * marks pairs already quality-checked with real inference; the admin form
 * still offers the rest but labels them unverified.
 */
export const SUPPORTED_LANGUAGES = [
	{ code: "en", verified: true },
	{ code: "es", verified: true },
	{ code: "pt", verified: true },
	{ code: "fr", verified: false },
	{ code: "de", verified: false },
	{ code: "it", verified: false },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]["code"];

const supportedCodes = new Set<string>(
	SUPPORTED_LANGUAGES.map((language) => language.code),
);

/** Whether a BCP 47 primary tag is in `SUPPORTED_LANGUAGES`. */
export function isSupportedLanguage(code: string): code is SupportedLanguage {
	return supportedCodes.has(code);
}
