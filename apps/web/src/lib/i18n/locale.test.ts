import { describe, expect, it } from "vitest";

import { resolveLocale } from "./locale";

describe("resolveLocale", () => {
	it("uses query, then cookie, then Accept-Language, then the default", () => {
		expect(resolveLocale("en", "es", "es", "es")).toBe("en");
		expect(resolveLocale(null, "en", "es", "es")).toBe("en");
		expect(resolveLocale(null, undefined, "en-US,en;q=0.8,es;q=0.5")).toBe(
			"en",
		);
		expect(resolveLocale(null, undefined, "fr-FR,es;q=0.7", "en")).toBe("es");
		expect(resolveLocale(null, undefined, "fr-FR", "es")).toBe("es");
	});

	it("ignores invalid and disabled language preferences", () => {
		expect(resolveLocale("fr", "en", "es")).toBe("en");
		expect(resolveLocale(null, undefined, "en;q=0,es;q=0.8")).toBe("es");
		expect(resolveLocale(null, undefined, "en;q=0.2,es;q=0.9")).toBe("es");
	});
});
