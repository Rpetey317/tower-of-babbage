import Link from "next/link";

import { getDictionary } from "~/lib/i18n";
import { getRequestLocale } from "~/lib/i18n/server";

export default async function NotFound() {
	// The statically rendered /_not-found route has no request headers.
	const locale = await getRequestLocale().catch(() => "es" as const);
	const copy = getDictionary(locale);

	return (
		<main className="mx-auto max-w-4xl px-4 py-16">
			<h1 className="font-display text-4xl uppercase tracking-wide">
				{copy.notFoundTitle}
			</h1>
			<Link
				className="mt-4 inline-block text-cyan text-sm hover:underline"
				href="/"
			>
				← {copy.backToSessions}
			</Link>
		</main>
	);
}
