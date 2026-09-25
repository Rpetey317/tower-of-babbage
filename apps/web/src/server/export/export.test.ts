import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
	buildCues,
	type Cue,
	formatTimestamp,
	formatTxtTimestamp,
	renderExport,
	splitSentences,
	toVtt,
	wrapCueText,
} from "./index";

function fixture(name: string): Cue[] {
	return JSON.parse(
		readFileSync(
			new URL(`__fixtures__/${name}.segments.json`, import.meta.url),
			"utf8",
		),
	) as Cue[];
}

/** Golden files regenerate with `UPDATE_GOLDEN=1` (docs/testing.md). */
function golden(name: string, actual: string) {
	const url = new URL(`__fixtures__/${name}`, import.meta.url);
	if (process.env.UPDATE_GOLDEN) {
		writeFileSync(url, actual);
	}
	expect(actual).toBe(readFileSync(url, "utf8"));
}

const formats = ["srt", "vtt", "txt"] as const;
const cases = ["basic", "split", "merge", "empty"] as const;

describe("golden exports", () => {
	for (const format of formats) {
		for (const name of cases) {
			it(`${name} -> ${format}`, () => {
				golden(`${name}.${format}`, renderExport(format, fixture(name)));
			});
		}
	}

	it("basic -> txt with timestamps", () => {
		golden(
			"basic.timestamps.txt",
			renderExport("txt", fixture("basic"), { timestamps: true }),
		);
	});
});

describe("formatTimestamp", () => {
	it("formats HH:MM:SS with the format separator", () => {
		expect(formatTimestamp(0, ",")).toBe("00:00:00,000");
		expect(formatTimestamp(3_723_456, ",")).toBe("01:02:03,456");
		expect(formatTimestamp(3_723_456, ".")).toBe("01:02:03.456");
	});

	it("formats the txt variant without millis", () => {
		expect(formatTxtTimestamp(65_000)).toBe("[00:01:05]");
	});
});

describe("splitSentences", () => {
	it("splits after sentence punctuation and closing quotes", () => {
		expect(splitSentences('He said "go now." Then left.')).toEqual([
			'He said "go now."',
			"Then left.",
		]);
	});

	it("returns one part without boundaries", () => {
		expect(splitSentences("no punctuation here")).toEqual([
			"no punctuation here",
		]);
	});
});

describe("buildCues", () => {
	it("splits a cue over 7 s proportionally to character count", () => {
		expect(
			buildCues([
				{ startMs: 0, endMs: 7100, text: "One two. Three four five." },
			]),
		).toEqual([
			{ startMs: 0, endMs: 2367, text: "One two." },
			{ startMs: 2367, endMs: 7100, text: "Three four five." },
		]);
	});

	it("keeps a long cue without sentence punctuation whole", () => {
		const segment = {
			startMs: 0,
			endMs: 9000,
			text: "a very long caption without sentence breaks at all",
		};
		expect(buildCues([segment])).toEqual([segment]);
	});

	it("merges a short cue into the following one", () => {
		expect(
			buildCues([
				{ startMs: 0, endMs: 400, text: "Hi." },
				{ startMs: 400, endMs: 2000, text: "Hello." },
			]),
		).toEqual([{ startMs: 0, endMs: 2000, text: "Hi. Hello." }]);
	});

	it("merges a trailing short cue into the previous one", () => {
		expect(
			buildCues([
				{ startMs: 0, endMs: 2000, text: "Hello." },
				{ startMs: 2000, endMs: 2400, text: "Bye." },
			]),
		).toEqual([{ startMs: 0, endMs: 2400, text: "Hello. Bye." }]);
	});

	it("keeps a lone short cue", () => {
		const segment = { startMs: 0, endMs: 300, text: "Hi." };
		expect(buildCues([segment])).toEqual([segment]);
	});

	it("preserves gaps and drops empty text", () => {
		expect(
			buildCues([
				{ startMs: 0, endMs: 1000, text: "a" },
				{ startMs: 1000, endMs: 2000, text: "   " },
				{ startMs: 5000, endMs: 7000, text: "b" },
			]),
		).toEqual([
			{ startMs: 0, endMs: 1000, text: "a" },
			{ startMs: 5000, endMs: 7000, text: "b" },
		]);
	});
});

describe("wrapCueText", () => {
	it("wraps greedily at the line width", () => {
		expect(wrapCueText("aa bb cc dd ee ff", 8)).toEqual([
			"aa bb cc",
			"dd ee ff",
		]);
	});

	it("collapses overflow into the last line", () => {
		const lines = wrapCueText(
			"one two three four five six seven eight nine ten eleven",
			20,
			2,
		);
		expect(lines).toHaveLength(2);
		expect(lines[0]?.length).toBeLessThanOrEqual(20);
		expect(lines[1]).toBe("five six seven eight nine ten eleven");
	});

	it("keeps an over-long word on its own line", () => {
		const word = "x".repeat(60);
		expect(wrapCueText(word)).toEqual([word]);
	});
});

describe("toVtt", () => {
	it("produces a header-only file for an empty run", () => {
		expect(toVtt([])).toBe("WEBVTT\n\n");
	});

	it("replaces --> inside cue text", () => {
		const vtt = toVtt([{ startMs: 0, endMs: 1000, text: "a --> b" }]);
		expect(vtt).toContain("a → b");
		expect(vtt.match(/-->/g)).toHaveLength(1);
	});
});
