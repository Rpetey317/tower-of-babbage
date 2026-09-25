import { headers } from "next/headers";
import Link from "next/link";

import { ConnectionPill } from "~/app/_components/connection-pill";
import { RoomDot } from "~/app/(audience)/_components/room-dot";
import { getDictionary } from "~/lib/i18n";
import { getRequestLocale } from "~/lib/i18n/server";
import { createCaller } from "~/server/api/root";
import { db } from "~/server/db";
import type { RouterOutputs } from "~/trpc/react";

export const dynamic = "force-dynamic";

type SessionRow = RouterOutputs["sessions"]["list"][number];

function isLive(status: SessionRow["status"]): boolean {
	return status === "running" || status === "starting";
}

/** Group by room keeping the list order: `running` first, then the rest. */
function groupByRoom(rows: SessionRow[]): [string, SessionRow[]][] {
	const sorted = [...rows].sort(
		(a, b) => Number(isLive(b.status)) - Number(isLive(a.status)),
	);
	const rooms = new Map<string, SessionRow[]>();
	for (const row of sorted) {
		const list = rooms.get(row.room);
		if (list) {
			list.push(row);
		} else {
			rooms.set(row.room, [row]);
		}
	}
	return [...rooms.entries()];
}

export default async function AudienceHome() {
	const locale = await getRequestLocale();
	const copy = getDictionary(locale);
	const caller = createCaller({ db, headers: await headers() });
	const sessionList = await caller.sessions.list();
	const rooms = groupByRoom(sessionList);

	return (
		<main className="mx-auto max-w-4xl px-4 py-8">
			<h1 className="font-display text-4xl uppercase tracking-wide">
				{copy.homeHeading}
			</h1>
			{rooms.length === 0 ? (
				<p className="mt-4 text-ink-300">{copy.emptySessions}</p>
			) : (
				rooms.map(([room, roomSessions]) => (
					<section className="mt-8" key={room || "no-room"}>
						<h2 className="flex items-center gap-2 font-semibold text-ink-300 text-sm uppercase tracking-wide">
							<RoomDot roomColor={roomSessions[0]?.roomColor ?? "grey"} />
							{room === "" ? copy.noRoom : room}
						</h2>
						<ul className="mt-3 space-y-3">
							{roomSessions.map((session) => {
								const live = isLive(session.status);
								return (
									<li key={session.id}>
										<Link
											className={`flex items-center justify-between gap-4 rounded-md border border-ink-700 bg-ink-900 px-4 py-3 transition-colors hover:border-violet focus-visible:outline-2 focus-visible:outline-cyan focus-visible:outline-offset-2 ${live ? "" : "opacity-60"}`}
											href={`/s/${session.slug}`}
										>
											<span>
												<span className="font-display text-2xl uppercase tracking-wide">
													{session.title}
												</span>
												<span className="block text-ink-300 text-sm">
													{session.sourceLanguage.toUpperCase()}
													{" → "}
													{session.targetLanguages
														.map((lang) => lang.toUpperCase())
														.join(", ")}
												</span>
											</span>
											<ConnectionPill
												kind={live ? "live" : "notlive"}
												label={live ? copy.liveBadge : copy.notLiveBadge}
											/>
										</Link>
									</li>
								);
							})}
						</ul>
					</section>
				))
			)}
		</main>
	);
}
