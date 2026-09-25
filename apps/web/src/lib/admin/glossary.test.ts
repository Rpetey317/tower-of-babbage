import { describe, expect, it } from "vitest";

import {
	GLOSSARY_CAP,
	mergeGlossary,
	parseBulkPaste,
} from "~/lib/admin/glossary";

describe("mergeGlossary", () => {
	it("orders session terms before global terms", () => {
		const merged = mergeGlossary(
			[{ term: "Nerdearla", translation: null }],
			[{ term: "kubectl", translation: null }],
		);
		expect(merged.map((item) => item.term)).toEqual(["Nerdearla", "kubectl"]);
	});

	it("dedupes case-insensitively and the session term wins", () => {
		const merged = mergeGlossary(
			[{ term: "Kubernetes", translation: "Kube" }],
			[{ term: "kubernetes", translation: null }],
		);
		expect(merged).toEqual([{ term: "Kubernetes", translation: "Kube" }]);
	});

	it("caps the merged list at GLOSSARY_CAP", () => {
		const sessionTerms = Array.from({ length: 10 }, (_, i) => ({
			term: `session-${i}`,
			translation: null,
		}));
		const globalTerms = Array.from({ length: GLOSSARY_CAP + 10 }, (_, i) => ({
			term: `global-${i}`,
			translation: null,
		}));
		const merged = mergeGlossary(sessionTerms, globalTerms);
		expect(merged).toHaveLength(GLOSSARY_CAP);
		expect(merged[0]?.term).toBe("session-0");
		expect(merged[GLOSSARY_CAP - 1]?.term).toBe("global-29");
	});

	it("skips blank terms", () => {
		const merged = mergeGlossary(
			[{ term: "  ", translation: null }],
			[{ term: "etcd", translation: null }],
		);
		expect(merged).toEqual([{ term: "etcd", translation: null }]);
	});
});

describe("parseBulkPaste", () => {
	it("parses term = translation lines", () => {
		expect(parseBulkPaste("Nerdearla\nkubectl = kube ctl\netcd =\n\n")).toEqual(
			[
				{ term: "Nerdearla", translation: null },
				{ term: "kubectl", translation: "kube ctl" },
				{ term: "etcd", translation: null },
			],
		);
	});

	it("splits on the first = only", () => {
		expect(parseBulkPaste("a = b = c")).toEqual([
			{ term: "a", translation: "b = c" },
		]);
	});

	it("dedupes repeated terms case-insensitively", () => {
		expect(parseBulkPaste("Etcd\nETCD = et c d")).toEqual([
			{ term: "Etcd", translation: null },
		]);
	});
});
