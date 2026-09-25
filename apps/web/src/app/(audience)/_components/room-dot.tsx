/**
 * `roomColor` values are the accent token names from docs/branding.md; the
 * literal class strings below keep Tailwind's scanner aware of them.
 */
const colorClasses: Record<string, string> = {
	violet: "bg-violet",
	cyan: "bg-cyan",
	green: "bg-green",
	orange: "bg-orange",
	yellow: "bg-yellow",
	magenta: "bg-magenta",
	grey: "bg-grey",
};

export function roomColorClass(roomColor: string): string {
	return colorClasses[roomColor] ?? "bg-grey";
}

export function RoomDot({ roomColor }: { roomColor: string }) {
	return (
		<span
			aria-hidden="true"
			className={`inline-block h-3 w-3 shrink-0 rounded-full ${roomColorClass(roomColor)}`}
		/>
	);
}
