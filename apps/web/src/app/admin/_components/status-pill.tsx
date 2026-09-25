const colors: Record<string, string> = {
	idle: "bg-grey text-ink-950",
	starting: "bg-orange text-ink-950",
	running: "bg-green text-ink-950",
	stopping: "bg-orange text-ink-950",
	error: "bg-coral text-ink-950",
};

const labels: Record<
	string,
	| "adminStatusIdle"
	| "adminStatusStarting"
	| "adminStatusRunning"
	| "adminStatusStopping"
	| "adminStatusError"
> = {
	idle: "adminStatusIdle",
	starting: "adminStatusStarting",
	running: "adminStatusRunning",
	stopping: "adminStatusStopping",
	error: "adminStatusError",
};

/** Status pill per admin-panel.md: error red, starting/stopping orange. */
export function StatusPill({
	status,
	copy,
}: {
	status: string;
	copy: Record<string, string>;
}) {
	return (
		<span
			className={`inline-block rounded-full px-2 py-0.5 font-semibold text-xs ${colors[status] ?? "bg-ink-700 text-ink-100"}`}
		>
			{copy[labels[status] ?? "adminStatusIdle"] ?? status}
		</span>
	);
}
