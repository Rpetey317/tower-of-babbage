import { en } from "./en";
import { es } from "./es";
import type { Locale } from "./locale";

export const dictionaries = { es, en };

export function getDictionary(locale: Locale) {
	return dictionaries[locale];
}
