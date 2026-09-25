"use client";

import { useRouter } from "next/navigation";

import { api } from "~/trpc/react";

const busyStatuses = new Set(["starting", "running", "stopping"]);

/**
 * Start/stop buttons for one session row or header. The status prop is the
 * last known status; mutations refresh the server component data on settle.
 */
export function SessionActions({
	sessionId,
	status,
	labels,
}: {
	sessionId: string;
	status: string;
	labels: { start: string; stop: string; stopping: string };
}) {
	const router = useRouter();
	const refresh = () => router.refresh();
	const start = api.admin.sessions.start.useMutation({ onSettled: refresh });
	const stop = api.admin.sessions.stop.useMutation({ onSettled: refresh });
	const pending = start.isPending || stop.isPending;

	if (status === "stopping") {
		return (
			<button
				className="rounded-md bg-ink-700 px-3 py-1 font-semibold text-ink-300 text-sm"
				disabled
				type="button"
			>
				{labels.stopping}
			</button>
		);
	}

	return (
		<div className="flex gap-2">
			<button
				className="rounded-md bg-green px-3 py-1 font-semibold text-ink-950 text-sm transition-opacity disabled:opacity-40"
				disabled={pending || busyStatuses.has(status)}
				onClick={() => start.mutate({ id: sessionId })}
				type="button"
			>
				{labels.start}
			</button>
			<button
				className="rounded-md bg-orange px-3 py-1 font-semibold text-ink-950 text-sm transition-opacity disabled:opacity-40"
				disabled={pending || !(busyStatuses.has(status) || status === "error")}
				onClick={() => stop.mutate({ id: sessionId })}
				type="button"
			>
				{labels.stop}
			</button>
		</div>
	);
}
