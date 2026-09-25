import { describe, expect, it } from "vitest";

import { en } from "./en";
import { es } from "./es";
import { getDictionary } from "./index";

describe("dictionaries", () => {
	// Type-level parity is enforced by `satisfies` in en.ts; this is the
	// runtime backstop required by docs/components/languages.md, so a
	// refactor that drops the annotation still fails loudly with the list
	// of missing keys.
	it("es and en define exactly the same keys", () => {
		const esKeys = Object.keys(es).sort();
		const enKeys = Object.keys(en).sort();
		expect(enKeys.filter((key) => !esKeys.includes(key))).toEqual([]);
		expect(esKeys.filter((key) => !enKeys.includes(key))).toEqual([]);
	});

	it("every entry is a non-empty string in both locales", () => {
		for (const dict of [es, en]) {
			for (const [key, value] of Object.entries(dict)) {
				expect(typeof value, key).toBe("string");
				expect(value.trim().length, key).toBeGreaterThan(0);
			}
		}
	});

	it("getDictionary returns the dictionary for each locale", () => {
		expect(getDictionary("es")).toBe(es);
		expect(getDictionary("en")).toBe(en);
	});
});
