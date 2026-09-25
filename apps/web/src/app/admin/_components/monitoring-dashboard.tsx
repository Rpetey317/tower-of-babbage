"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
	ConnectionPill,
	type PillKind,
} from "~/app/(audience)/_components/connection-pill";
import {
	audioStalled,
	formatAudioMs,
	formatLatencyMs,
	hasDroppedChunks,
	latencyHigh,
	queueSaturated,
	type Stats,
} from "~/lib/admin/monitoring";
import { roomColorClasses } from "~/lib/admin/options";
import type { Dictionary } from "~/lib/i18n";
import { api, type RouterOutputs } from "~/trpc/react";

import { SessionActions } from "./session-actions";
import { StatusPill } from "./status-pill";

type Row = RouterOutputs["admin"]["sessions"]["list"][number];

/**
 * Fields a `status`/`log` event can change between `sessions.list` refetches.
 * `at` is the event's `emittedAt`: it is compared against the row's
 * `updatedAt` so a refetch that predates the last applied event does not
 * regress the row (the events endpoint commits before publishing, so any
 * newer row already contains the event's effect).
 */
interface LiveUpdate {
	status?: string;
	stats?: Stats | null;
	lastError: string | null;
	at: number;
}

function merged(row: Row, live: LiveUpdate | undefined) {
	if (!live || live.at <= row.updatedAt.getTime()) {
		return row;
	}
	return {
		...row,
		status: live.status ?? row.status,
		stats: live.stats ?? row.stats,
		lastError: live.lastError,
	};
}

function dotColor(roomColor: string): string {
	return (
		roomColorClasses[roomColor as keyof typeof roomColorClasses] ?? "bg-grey"
	);
}

/**
 * Monitoring table per admin-panel.md: stats columns with alarms, live via
 * `admin.onStatus`, reconciled by a `sessions.list` refetch every 10 s (new,
 * edited and deleted sessions only arrive through the query).
 */
export function MonitoringDashboard({
	initialRows,
	copy,
}: {
	initialRows: Row[];
	copy: Dictionary;
}) {
	const [overrides, setOverrides] = useState<Map<string, LiveUpdate>>(
		() => new Map(),
	);
	const [now, setNow] = useState(() => Date.now());

	const list = api.admin.sessions.list.useQuery(undefined, {
		initialData: initialRows,
		refetchInterval: 10_000,
	});

	const subscription = api.admin.onStatus.useSubscription(undefined, {
		onData: (item) => {
			const event = item.data;
			if (event.type === "ping") return;
			const at = Date.parse(event.emittedAt);
			if (event.type === "status") {
				setOverrides((prev) => {
					const next = new Map(prev);
					next.set(event.sessionId, {
						status: event.status,
						stats: event.stats,
						lastError: event.stats.lastError,
						at,
					});
					return next;
				});
			} else if (event.type === "log" && event.level === "error") {
				setOverrides((prev) => {
					const next = new Map(prev);
					next.set(event.sessionId, {
						...prev.get(event.sessionId),
						lastError: event.message,
						at,
					});
					return next;
				});
			}
		},
	});

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, []);

	const pillKind: PillKind =
		subscription.status === "pending" ? "live" : "reconnecting";
	const pillLabel = pillKind === "live" ? copy.connLive : copy.connReconnecting;

	const rows = list.data ?? initialRows;

	return (
		<section className="mt-8">
			<div className="mb-3 flex justify-end">
				<ConnectionPill kind={pillKind} label={pillLabel} />
			</div>
			<table className="w-full border-collapse text-left text-sm">
				<thead>
					<tr className="border-ink-700 border-b text-ink-300">
						<th className="py-2 pr-4 font-semibold">{copy.adminColSession}</th>
						<th className="py-2 pr-4 font-semibold">{copy.adminColRoom}</th>
						<th className="py-2 pr-4 font-semibold">
							{copy.adminColLanguages}
						</th>
						<th className="py-2 pr-4 font-semibold">{copy.adminColStatus}</th>
						<th className="py-2 pr-4 font-semibold">{copy.adminColAudio}</th>
						<th className="py-2 pr-4 font-semibold">{copy.adminColQueue}</th>
						<th className="py-2 pr-4 font-semibold">{copy.adminColLatency}</th>
						<th className="py-2 pr-4 font-semibold">{copy.adminColDropped}</th>
						<th className="py-2 pr-4 font-semibold">
							{copy.adminColLastError}
						</th>
						<th className="py-2 font-semibold">{copy.adminColActions}</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => {
						const view = merged(row, overrides.get(row.id));
						const stats = view.stats;
						const active =
							view.status === "running" || view.status === "starting";
						const stalled =
							active && stats !== null
								? audioStalled(stats, view.startedAt, now)
								: false;
						return (
							<tr className="border-ink-700 border-b align-middle" key={row.id}>
								<td className="py-3 pr-4">
									<Link
										className="font-semibold text-ink-100 hover:text-cyan"
										href={`/admin/sessions/${row.id}`}
									>
										{row.title}
									</Link>
									<div className="text-ink-500 text-xs">{row.slug}</div>
								</td>
								<td className="py-3 pr-4">
									<span
										className={`mr-2 inline-block h-3 w-3 rounded-full ${dotColor(row.roomColor)}`}
									/>
									{row.room}
								</td>
								<td className="py-3 pr-4">
									{row.sourceLanguage} → {row.targetLanguages.join(", ")}
								</td>
								<td className="py-3 pr-4">
									<StatusPill copy={copy} status={view.status} />
								</td>
								<td
									className={`py-3 pr-4 tabular-nums ${stalled ? "text-coral" : ""}`}
									title={stalled ? copy.adminAlarmAudio : undefined}
								>
									{stats ? formatAudioMs(stats.audioReceivedMs) : "—"}
								</td>
								<td
									className={`py-3 pr-4 tabular-nums ${stats && queueSaturated(stats) ? "text-orange" : ""}`}
									title={
										stats && queueSaturated(stats)
											? copy.adminAlarmQueue
											: undefined
									}
								>
									{stats ? stats.queueDepth : "—"}
								</td>
								<td
									className={`py-3 pr-4 tabular-nums ${stats && latencyHigh(stats) ? "text-coral" : ""}`}
									title={
										stats && latencyHigh(stats)
											? copy.adminAlarmLatency
											: undefined
									}
								>
									{stats
										? `${formatLatencyMs(stats.latencyP50Ms)} / ${formatLatencyMs(stats.latencyP95Ms)}`
										: "—"}
								</td>
								<td
									className={`py-3 pr-4 tabular-nums ${stats && hasDroppedChunks(stats) ? "text-coral" : ""}`}
									title={
										stats && hasDroppedChunks(stats)
											? copy.adminAlarmDropped
											: undefined
									}
								>
									{stats ? stats.chunksDropped : "—"}
								</td>
								<td className="max-w-48 truncate py-3 pr-4 text-coral text-xs">
									{view.lastError}
								</td>
								<td className="py-3">
									<div className="flex items-center gap-3">
										<SessionActions
											labels={{
												start: copy.adminStart,
												stop: copy.adminStop,
												stopping: copy.adminStatusStopping,
											}}
											sessionId={row.id}
											status={view.status}
										/>
										<Link
											className="text-cyan text-sm hover:underline"
											href={`/admin/sessions/${row.id}`}
										>
											{copy.adminEdit}
										</Link>
									</div>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</section>
	);
}
