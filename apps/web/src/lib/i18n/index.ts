import { en } from "./en";
import { es } from "./es";
import type { Locale } from "./locale";

export const dictionaries = { es, en };

/** Every dictionary key maps to a plain string; both locales satisfy it. */
export type Dictionary = Record<keyof typeof es, string>;

export function getDictionary(locale: Locale) {
	return dictionaries[locale];
}
