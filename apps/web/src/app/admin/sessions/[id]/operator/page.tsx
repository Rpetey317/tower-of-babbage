import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { env } from "~/env";
import { getDictionary } from "~/lib/i18n";
import { getRequestLocale } from "~/lib/i18n/server";
import { db } from "~/server/db";
import { sessions } from "~/server/db/schema";

import { StatusPill } from "../../../_components/status-pill";
import { OperatorConsole } from "./operator-console";

export const dynamic = "force-dynamic";

export default async function OperatorPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const copy = getDictionary(await getRequestLocale());
	const { id } = await params;
	const [session] = await db.select().from(sessions).where(eq(sessions.id, id));
	if (!session) notFound();

	return (
		<main className="mx-auto max-w-3xl px-4 py-12">
			<Link
				className="text-cyan text-sm hover:underline"
				href={`/admin/sessions/${session.id}`}
			>
				← {copy.adminBackToSession}
			</Link>
			<div className="mt-4 flex items-center gap-4">
				<h1 className="font-display text-4xl uppercase tracking-wide">
					{session.title}
				</h1>
				<StatusPill copy={copy} status={session.status} />
			</div>
			<h2 className="mt-8 font-display text-2xl uppercase tracking-wide">
				{copy.operatorTitle}
			</h2>
			<OperatorConsole
				copy={copy}
				sessionId={session.id}
				sourceType={session.sourceType}
				wsUrl={env.NEXT_PUBLIC_PIPELINE_WS_URL}
			/>
		</main>
	);
}
