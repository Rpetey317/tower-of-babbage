import { describe, expect, it } from "vitest";

import { resolveOverlayParams } from "./overlay";

const session = { sourceLanguage: "en", targetLanguages: ["es", "pt"] };

describe("resolveOverlayParams", () => {
	it("applies the documented defaults", () => {
		expect(resolveOverlayParams({ query: {}, ...session })).toEqual({
			language: "es",
			mode: "translation",
			languages: ["es"],
			lines: 2,
			size: 48,
			align: "bottom",
			bg: "band",
			margin: 64,
			fade: false,
		});
	});

	it("falls back to the first target language when none is declared", () => {
		const params = resolveOverlayParams({
			query: {},
			sourceLanguage: "en",
			targetLanguages: [],
		});
		expect(params.language).toBe("en");
		expect(params.languages).toEqual(["en"]);
	});

	it("accepts a declared target language and rejects unknown codes", () => {
		expect(
			resolveOverlayParams({ query: { lang: "pt" }, ...session }).language,
		).toBe("pt");
		expect(
			resolveOverlayParams({ query: { lang: "fr" }, ...session }).language,
		).toBe("es");
	});

	it("subscribes to the original track when lang names the source", () => {
		const params = resolveOverlayParams({
			query: { lang: "en" },
			...session,
		});
		expect(params.languages).toEqual(["en"]);
	});

	it("stacks original over translation in both mode", () => {
		const params = resolveOverlayParams({
			query: { mode: "both" },
			...session,
		});
		expect(params.mode).toBe("both");
		expect(params.languages).toEqual(["en", "es"]);
	});

	it("ignores invalid mode values", () => {
		expect(
			resolveOverlayParams({ query: { mode: "side" }, ...session }).mode,
		).toBe("translation");
	});

	it("parses lines, size and margin and clamps them to bounds", () => {
		const params = resolveOverlayParams({
			query: { lines: "3", size: "72", margin: "120" },
			...session,
		});
		expect(params.lines).toBe(3);
		expect(params.size).toBe(72);
		expect(params.margin).toBe(120);

		const clamped = resolveOverlayParams({
			query: { lines: "99", size: "4", margin: "-10" },
			...session,
		});
		expect(clamped.lines).toBe(8);
		expect(clamped.size).toBe(12);
		expect(clamped.margin).toBe(0);
	});

	it("falls back to defaults for non-numeric and empty values", () => {
		const params = resolveOverlayParams({
			query: { lines: "abc", size: "", margin: "x1" },
			...session,
		});
		expect(params.lines).toBe(2);
		expect(params.size).toBe(48);
		expect(params.margin).toBe(64);
	});

	it("takes the first value of repeated params", () => {
		const params = resolveOverlayParams({
			query: { lines: ["4", "9"], align: ["top", "bottom"] },
			...session,
		});
		expect(params.lines).toBe(4);
		expect(params.align).toBe("top");
	});

	it("accepts top alignment and box/none backgrounds", () => {
		for (const [align, bg, expected] of [
			["top", "box", { align: "top", bg: "box" }],
			["bottom", "none", { align: "bottom", bg: "none" }],
			["middle", "solid", { align: "bottom", bg: "band" }],
		] as const) {
			const params = resolveOverlayParams({
				query: { align, bg },
				...session,
			});
			expect(params.align).toBe(expected.align);
			expect(params.bg).toBe(expected.bg);
		}
	});

	it("enables fade only with anim=fade", () => {
		expect(
			resolveOverlayParams({ query: { anim: "fade" }, ...session }).fade,
		).toBe(true);
		expect(
			resolveOverlayParams({ query: { anim: "slide" }, ...session }).fade,
		).toBe(false);
	});
});
