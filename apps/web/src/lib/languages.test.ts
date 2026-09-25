import { describe, expect, it } from "vitest";

import { isSupportedLanguage, SUPPORTED_LANGUAGES } from "~/lib/languages";

describe("SUPPORTED_LANGUAGES", () => {
	// The list must mirror the pipeline's languageNames table
	// (services/pipeline/internal/provider/languages.go).
	it("matches the pipeline language table", () => {
		expect(SUPPORTED_LANGUAGES.map((language) => language.code)).toEqual([
			"en",
			"es",
			"pt",
			"fr",
			"de",
			"it",
		]);
	});

	it("verifies only the pairs checked with real inference", () => {
		expect(
			SUPPORTED_LANGUAGES.filter((language) => language.verified).map(
				(language) => language.code,
			),
		).toEqual(["en", "es", "pt"]);
	});

	it("uses lowercase BCP 47 primary tags", () => {
		for (const language of SUPPORTED_LANGUAGES) {
			expect(language.code).toMatch(/^[a-z]{2,3}$/);
		}
	});
});

describe("isSupportedLanguage", () => {
	it("accepts every listed code, verified or not", () => {
		for (const language of SUPPORTED_LANGUAGES) {
			expect(isSupportedLanguage(language.code)).toBe(true);
		}
	});

	it.each(["xx", "en-US", "EN", "english", ""])("rejects %j", (code) => {
		expect(isSupportedLanguage(code)).toBe(false);
	});
});
