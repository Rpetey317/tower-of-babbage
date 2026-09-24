"use client";

import type { Locale } from "~/lib/i18n/locale";

export function LocaleToggle({
	locale,
	label,
}: {
	locale: Locale;
	label: string;
}) {
	function choose(nextLocale: Locale) {
		const url = new URL(window.location.href);
		url.searchParams.set("hl", nextLocale);
		window.location.assign(url);
	}

	return (
		<fieldset className="inline-flex rounded-md border border-ink-700 p-1">
			<legend className="sr-only">{label}</legend>
			{(["es", "en"] as const).map((option) => (
				<button
					aria-pressed={locale === option}
					className="rounded px-3 py-1 font-semibold text-ink-300 text-sm transition-colors hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-cyan focus-visible:outline-offset-2 aria-pressed:bg-cyan aria-pressed:text-ink-950"
					key={option}
					onClick={() => choose(option)}
					type="button"
				>
					{option.toUpperCase()}
				</button>
			))}
		</fieldset>
	);
}
