import { asc, desc } from "drizzle-orm";
import Link from "next/link";

import { getDictionary } from "~/lib/i18n";
import { getRequestLocale } from "~/lib/i18n/server";
import { db } from "~/server/db";
import { sessions } from "~/server/db/schema";
import { latestStats } from "~/server/events/state";

import { DemoSessionsButton } from "./_components/demo-sessions-button";
import { MonitoringDashboard } from "./_components/monitoring-dashboard";
import { PipelineHealth } from "./_components/pipeline-health";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
	const copy = getDictionary(await getRequestLocale());
	const sessionRows = await db
		.select()
		.from(sessions)
		.orderBy(desc(sessions.createdAt), asc(sessions.id));
	const initialRows = sessionRows.map((session) => ({
		...session,
		stats: latestStats(session.id) ?? null,
	}));

	return (
		<main className="mx-auto max-w-6xl px-4 py-12">
			<div className="flex items-center justify-between gap-4">
				<h1 className="font-display text-4xl uppercase tracking-wide">
					{copy.adminDashboardTitle}
				</h1>
				<Link
					className="rounded-md bg-violet px-4 py-2 font-semibold text-ink-100 transition-colors hover:bg-violet-hover"
					href="/admin/sessions/new"
				>
					{copy.adminNewSession}
				</Link>
			</div>

			<PipelineHealth copy={copy} />

			{initialRows.length === 0 ? (
				<div className="mt-8 flex items-center gap-4">
					<p className="text-ink-300">{copy.adminEmptySessions}</p>
					<DemoSessionsButton label={copy.adminCreateDemo} />
				</div>
			) : (
				<MonitoringDashboard copy={copy} initialRows={initialRows} />
			)}
		</main>
	);
}
