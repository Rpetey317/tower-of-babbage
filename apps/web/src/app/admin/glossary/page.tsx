import { asc, isNull } from "drizzle-orm";
import Link from "next/link";

import { getDictionary } from "~/lib/i18n";
import { getRequestLocale } from "~/lib/i18n/server";
import { db } from "~/server/db";
import { glossaryTerms } from "~/server/db/schema";

import { GlossaryEditor } from "../_components/glossary-editor";

export const dynamic = "force-dynamic";

export default async function GlossaryPage() {
	const copy = getDictionary(await getRequestLocale());
	const terms = await db
		.select()
		.from(glossaryTerms)
		.where(isNull(glossaryTerms.sessionId))
		.orderBy(asc(glossaryTerms.createdAt), asc(glossaryTerms.id));

	return (
		<main className="mx-auto max-w-6xl px-4 py-12">
			<Link className="text-cyan text-sm hover:underline" href="/admin">
				← {copy.adminBackToList}
			</Link>
			<h1 className="mt-4 font-display text-4xl uppercase tracking-wide">
				{copy.adminGlossaryTitle}
			</h1>
			<GlossaryEditor copy={copy} initialTerms={terms} />
		</main>
	);
}
