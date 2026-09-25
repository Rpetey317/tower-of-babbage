/**
 * Glossary helpers shared by the admin router and its tests. Semantics come
 * from docs/components/glossary.md: session terms first, then global terms,
 * deduplicated by lowercase `term`, capped at `GLOSSARY_CAP` so prompt tokens
 * stay cheap.
 */

export const GLOSSARY_CAP = 40;

export interface GlossaryTermInput {
	term: string;
	translation: string | null;
}

/** Session terms win over global ones on a case-insensitive `term` clash. */
export function mergeGlossary(
	sessionTerms: GlossaryTermInput[],
	globalTerms: GlossaryTermInput[],
): GlossaryTermInput[] {
	const seen = new Set<string>();
	const merged: GlossaryTermInput[] = [];
	for (const item of [...sessionTerms, ...globalTerms]) {
		const key = item.term.trim().toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		merged.push({ term: item.term, translation: item.translation });
		if (merged.length >= GLOSSARY_CAP) break;
	}
	return merged;
}

/**
 * Parses the bulk-paste format: one term per line, optionally
 * `term = translation`. Blank lines are skipped; a term repeated later in the
 * same paste keeps its first definition.
 */
export function parseBulkPaste(text: string): GlossaryTermInput[] {
	const seen = new Set<string>();
	const parsed: GlossaryTermInput[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const separator = line.indexOf("=");
		const term = (separator === -1 ? line : line.slice(0, separator)).trim();
		const translation =
			separator === -1 ? null : line.slice(separator + 1).trim() || null;
		const key = term.toLowerCase();
		if (!term || seen.has(key)) continue;
		seen.add(key);
		parsed.push({ term, translation });
	}
	return parsed;
}
