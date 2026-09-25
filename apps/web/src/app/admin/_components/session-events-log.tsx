"use client";

import { useMemo, useState } from "react";

import type { Dictionary } from "~/lib/i18n";
import { api, type RouterOutputs } from "~/trpc/react";

type EventRow = RouterOutputs["admin"]["events"]["recent"][number];

interface LiveEvent {
	runId: string | null;
	level: "info" | "warn" | "error";
	code: string;
	message: string;
	data: unknown;
	emittedAt: string;
}

const levelClasses: Record<LiveEvent["level"], string> = {
	info: "bg-ink-700 text-ink-100",
	warn: "bg-orange text-ink-950",
	error: "bg-coral text-ink-950",
};

const maxLiveEvents = 200;

/**
 * Dedupe key shared by live `log` events and `session_events` rows: the row's
 * `createdAt` differs from the event's `emittedAt`, so identity is the
 * content itself.
 */
function eventKey(event: {
	runId: string | null;
	level: string;
	code: string;
	message: string;
	data: unknown;
}): string {
	return [
		event.runId ?? "",
		event.level,
		event.code,
		event.message,
		JSON.stringify(event.data ?? null),
	].join("|");
}

/**
 * Last `session_events` for a session, newest first. Refetches every 15 s and
 * prepends `log` events streamed by `admin.onStatus` in between.
 */
export function SessionEventsLog({
	sessionId,
	initialEvents,
	copy,
}: {
	sessionId: string;
	initialEvents: EventRow[];
	copy: Dictionary;
}) {
	const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);

	const recent = api.admin.events.recent.useQuery(
		{ sessionId, limit: 100 },
		{ initialData: initialEvents, refetchInterval: 15_000 },
	);

	api.admin.onStatus.useSubscription(undefined, {
		onData: (item) => {
			const event = item.data;
			if (event.type !== "log" || event.sessionId !== sessionId) return;
			setLiveEvents((prev) =>
				[
					{
						runId: event.runId,
						level: event.level,
						code: event.code,
						message: event.message,
						data: event.data ?? null,
						emittedAt: event.emittedAt,
					},
					...prev,
				].slice(0, maxLiveEvents),
			);
		},
	});

	const entries = useMemo(() => {
		const rows = recent.data ?? initialEvents;
		const persisted = new Set(rows.map(eventKey));
		return [
			...liveEvents
				.filter((event) => !persisted.has(eventKey(event)))
				.map((event) => ({
					key: `live:${eventKey(event)}`,
					time: event.emittedAt,
					level: event.level,
					code: event.code,
					message: event.message,
				})),
			...rows.map((row) => ({
				key: `row:${row.id}`,
				time: row.createdAt.toISOString(),
				level: row.level,
				code: row.code,
				message: row.message,
			})),
		];
	}, [liveEvents, recent.data, initialEvents]);

	return (
		<section className="mt-8">
			<h2 className="font-display text-2xl uppercase tracking-wide">
				{copy.adminEventsTitle}
			</h2>
			{entries.length === 0 ? (
				<p className="mt-3 text-ink-300 text-sm">{copy.adminEventsEmpty}</p>
			) : (
				<table className="mt-3 w-full border-collapse text-left text-sm">
					<thead>
						<tr className="border-ink-700 border-b text-ink-300">
							<th className="py-2 pr-4 font-semibold">{copy.adminColTime}</th>
							<th className="py-2 pr-4 font-semibold">{copy.adminColLevel}</th>
							<th className="py-2 pr-4 font-semibold">{copy.adminColCode}</th>
							<th className="py-2 font-semibold">{copy.adminColMessage}</th>
						</tr>
					</thead>
					<tbody>
						{entries.map((entry) => (
							<tr className="border-ink-700 border-b align-top" key={entry.key}>
								<td className="py-2 pr-4 text-ink-300 tabular-nums">
									{new Date(entry.time).toLocaleTimeString("en-GB")}
								</td>
								<td className="py-2 pr-4">
									<span
										className={`inline-block rounded-full px-2 py-0.5 font-semibold text-xs ${levelClasses[entry.level] ?? levelClasses.info}`}
									>
										{entry.level}
									</span>
								</td>
								<td className="py-2 pr-4 font-mono text-ink-300 text-xs">
									{entry.code}
								</td>
								<td className="py-2 text-ink-100">{entry.message}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}
