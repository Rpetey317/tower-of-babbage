export type PillKind = "live" | "reconnecting" | "notlive";

const styles: Record<PillKind, { dot: string; text: string; border: string }> =
	{
		live: { dot: "bg-green", text: "text-green", border: "border-green/40" },
		reconnecting: {
			dot: "bg-orange",
			text: "text-orange",
			border: "border-orange/40",
		},
		notlive: { dot: "bg-grey", text: "text-grey", border: "border-ink-700" },
	};

export function ConnectionPill({
	kind,
	label,
}: {
	kind: PillKind;
	label: string;
}) {
	const style = styles[kind];
	return (
		<span
			className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 font-semibold text-sm ${style.border} ${style.text}`}
			role="status"
		>
			<span
				aria-hidden="true"
				className={`h-2 w-2 rounded-full ${style.dot}`}
			/>
			{label}
		</span>
	);
}
