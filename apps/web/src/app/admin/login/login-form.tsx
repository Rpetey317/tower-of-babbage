"use client";

import { useActionState } from "react";

import { type LoginState, login } from "./actions";

export function LoginForm({
	labels,
}: {
	labels: { password: string; submit: string; error: string };
}) {
	const [state, action, pending] = useActionState<LoginState, FormData>(login, {
		error: null,
	});

	return (
		<form action={action} className="mt-6 flex flex-col gap-4">
			<label className="flex flex-col gap-1 text-ink-300 text-sm">
				{labels.password}
				<input
					autoComplete="current-password"
					className="rounded-md border border-ink-700 bg-ink-800 px-3 py-2 text-ink-100 focus-visible:outline-2 focus-visible:outline-cyan"
					name="password"
					required
					type="password"
				/>
			</label>
			{state.error === "invalid_password" && (
				<p className="text-coral text-sm" role="alert">
					{labels.error}
				</p>
			)}
			<button
				className="rounded-md bg-violet px-4 py-2 font-semibold text-ink-100 transition-colors hover:bg-violet-hover disabled:opacity-50"
				disabled={pending}
				type="submit"
			>
				{labels.submit}
			</button>
		</form>
	);
}
