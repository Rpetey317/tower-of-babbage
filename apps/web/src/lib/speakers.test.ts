import { describe, expect, it } from "vitest";

import {
	speakerAccent,
	speakerAccents,
	speakerName,
	speakerTextClass,
} from "./speakers";

describe("speaker accents", () => {
	it("cycles the palette over numbered speakers in order", () => {
		expect(
			["S1", "S2", "S3", "S4", "S5", "S6", "S7"].map(speakerAccent),
		).toEqual([
			"cyan",
			"violet",
			"green",
			"orange",
			"magenta",
			"yellow",
			"cyan",
		]);
	});

	it("is stable and only ever returns branding accent tokens", () => {
		for (const speaker of ["S1", "S2", "S12", "keynote", "intérprete 2"]) {
			const accent = speakerAccent(speaker);
			expect(speakerAccents).toContain(accent);
			expect(speakerAccent(speaker)).toBe(accent);
			expect(speakerTextClass(speaker)).toBe(`text-${accent}`);
		}
	});
});

describe("speaker names", () => {
	it("renders numbered labels through the locale template", () => {
		expect(speakerName("S1", "Orador {n}")).toBe("Orador 1");
		expect(speakerName("S12", "Speaker {n}")).toBe("Speaker 12");
	});

	it("passes through labels that are not numbered", () => {
		expect(speakerName("keynote", "Speaker {n}")).toBe("keynote");
	});
});
