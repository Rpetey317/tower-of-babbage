"use client";

import { useRouter } from "next/navigation";

import { api } from "~/trpc/react";

/**
 * Seeds the two `file_replay` demo sessions (`demo-en`, `demo-es`) so an empty
 * dashboard can show the whole flow. Idempotent on the server.
 */
export function DemoSessionsButton({ label }: { label: string }) {
	const router = useRouter();
	const seed = api.admin.sessions.createDemo.useMutation({
		onSettled: () => router.refresh(),
	});

	return (
		<button
			className="rounded-md bg-cyan px-4 py-2 font-semibold text-ink-950 transition-opacity disabled:opacity-50"
			disabled={seed.isPending}
			onClick={() => seed.mutate()}
			type="button"
		>
			{label}
		</button>
	);
}
