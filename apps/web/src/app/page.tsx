import { getDictionary } from "~/lib/i18n";
import { getRequestLocale } from "~/lib/i18n/server";

export default async function Home() {
	const copy = getDictionary(await getRequestLocale());

	return (
		<main className="mx-auto max-w-6xl px-4 py-12">
			<h1 className="font-display text-4xl uppercase tracking-wide">
				{copy.homeHeading}
			</h1>
			<p className="mt-4 text-ink-300">{copy.emptySessions}</p>
		</main>
	);
}
