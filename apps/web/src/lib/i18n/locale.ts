export type Locale = "es" | "en";

export function isLocale(value: string | null | undefined): value is Locale {
	return value === "es" || value === "en";
}

/** Resolve the UI locale in the order documented for audience pages. */
export function resolveLocale(
	queryLocale: string | null,
	cookieLocale: string | undefined,
	acceptLanguage: string | null,
	defaultLocale: Locale = "es",
): Locale {
	if (isLocale(queryLocale)) return queryLocale;
	if (isLocale(cookieLocale)) return cookieLocale;

	const preferred = (acceptLanguage ?? "")
		.split(",")
		.map((part) => {
			const [tag = "", weight] = part.trim().split(";q=");
			return {
				tag: tag.toLowerCase().split("-")[0],
				quality: weight ? Number(weight) : 1,
			};
		})
		.filter((part) => Number.isFinite(part.quality) && part.quality > 0)
		.sort((a, b) => b.quality - a.quality);

	for (const { tag } of preferred) {
		if (isLocale(tag)) return tag;
	}
	return defaultLocale;
}
