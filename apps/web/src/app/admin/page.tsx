import { desc } from "drizzle-orm";
import Link from "next/link";

import { getDictionary } from "~/lib/i18n";
import { getRequestLocale } from "~/lib/i18n/server";
import { db } from "~/server/db";
import { sessions } from "~/server/db/schema";

import { SessionActions } from "./_components/session-actions";
import { StatusPill } from "./_components/status-pill";

export const dynamic = "force-dynamic";

const dotColors: Record<string, string> = {
	violet: "bg-violet",
	cyan: "bg-cyan",
	green: "bg-green",
	orange: "bg-orange",
	yellow: "bg-yellow",
	magenta: "bg-magenta",
	grey: "bg-grey",
};

export default async function AdminPage() {
	const copy = getDictionary(await getRequestLocale());
	const rows = await db
		.select()
		.from(sessions)
		.orderBy(desc(sessions.createdAt));

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

			{rows.length === 0 ? (
				<p className="mt-8 text-ink-300">{copy.adminEmptySessions}</p>
			) : (
				<table className="mt-8 w-full border-collapse text-left text-sm">
					<thead>
						<tr className="border-ink-700 border-b text-ink-300">
							<th className="py-2 pr-4 font-semibold">
								{copy.adminColSession}
							</th>
							<th className="py-2 pr-4 font-semibold">{copy.adminColRoom}</th>
							<th className="py-2 pr-4 font-semibold">
								{copy.adminColLanguages}
							</th>
							<th className="py-2 pr-4 font-semibold">{copy.adminColStatus}</th>
							<th className="py-2 pr-4 font-semibold">
								{copy.adminColLastError}
							</th>
							<th className="py-2 font-semibold">{copy.adminColActions}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((session) => (
							<tr
								className="border-ink-700 border-b align-middle"
								key={session.id}
							>
								<td className="py-3 pr-4">
									<Link
										className="font-semibold text-ink-100 hover:text-cyan"
										href={`/admin/sessions/${session.id}`}
									>
										{session.title}
									</Link>
									<div className="text-ink-500 text-xs">{session.slug}</div>
								</td>
								<td className="py-3 pr-4">
									<span
										className={`mr-2 inline-block h-3 w-3 rounded-full ${dotColors[session.roomColor] ?? "bg-grey"}`}
									/>
									{session.room}
								</td>
								<td className="py-3 pr-4">
									{session.sourceLanguage} →{" "}
									{session.targetLanguages.join(", ")}
								</td>
								<td className="py-3 pr-4">
									<StatusPill copy={copy} status={session.status} />
								</td>
								<td className="max-w-48 truncate py-3 pr-4 text-coral text-xs">
									{session.lastError}
								</td>
								<td className="py-3">
									<div className="flex items-center gap-3">
										<SessionActions
											labels={{
												start: copy.adminStart,
												stop: copy.adminStop,
												stopping: copy.adminStatusStopping,
											}}
											sessionId={session.id}
											status={session.status}
										/>
										<Link
											className="text-cyan text-sm hover:underline"
											href={`/admin/sessions/${session.id}`}
										>
											{copy.adminEdit}
										</Link>
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</main>
	);
}
