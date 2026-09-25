"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { Dictionary } from "~/lib/i18n";
import { api, type RouterOutputs } from "~/trpc/react";

type TermRow = RouterOutputs["admin"]["glossary"]["list"][number];

const inputClass =
	"rounded-md border border-ink-700 bg-ink-800 px-3 py-2 text-ink-100 focus-visible:outline-2 focus-visible:outline-cyan";

/**
 * Editor for one glossary scope: global when `sessionId` is undefined, the
 * session's own terms otherwise. The add form doubles as the edit form: a
 * row's edit button loads it there and submit calls `upsert` with its id.
 */
export function GlossaryEditor({
	sessionId,
	initialTerms,
	copy,
}: {
	sessionId?: string;
	initialTerms: TermRow[];
	copy: Dictionary;
}) {
	const router = useRouter();
	const utils = api.useUtils();
	const terms = api.admin.glossary.list.useQuery(
		{ sessionId: sessionId ?? null },
		{ initialData: initialTerms },
	);

	const [editingId, setEditingId] = useState<string | null>(null);
	const [term, setTerm] = useState("");
	const [translation, setTranslation] = useState("");
	const [notes, setNotes] = useState("");
	const [bulkText, setBulkText] = useState("");
	const [error, setError] = useState<string | null>(null);

	const onSettled = () => {
		void utils.admin.glossary.list.invalidate();
		router.refresh();
	};
	const onError = (mutationError: { message: string }) =>
		setError(mutationError.message);
	const upsert = api.admin.glossary.upsert.useMutation({ onSettled, onError });
	const addMany = api.admin.glossary.addMany.useMutation({
		onSettled,
		onError,
		onSuccess: () => setBulkText(""),
	});
	const remove = api.admin.glossary.delete.useMutation({ onSettled, onError });
	const pending = upsert.isPending || addMany.isPending || remove.isPending;

	function startEdit(row: TermRow) {
		setEditingId(row.id);
		setTerm(row.term);
		setTranslation(row.translation ?? "");
		setNotes(row.notes ?? "");
		setError(null);
	}

	function resetForm() {
		setEditingId(null);
		setTerm("");
		setTranslation("");
		setNotes("");
	}

	function submitTerm(event: React.FormEvent) {
		event.preventDefault();
		setError(null);
		upsert.mutate(
			{
				id: editingId ?? undefined,
				sessionId: sessionId ?? null,
				term,
				translation: translation || null,
				notes: notes || null,
			},
			{ onSuccess: resetForm },
		);
	}

	function submitBulk(event: React.FormEvent) {
		event.preventDefault();
		setError(null);
		addMany.mutate({ sessionId: sessionId ?? null, text: bulkText });
	}

	const rows = terms.data ?? initialTerms;

	return (
		<div className="mt-4 max-w-3xl">
			{rows.length === 0 ? (
				<p className="text-ink-300 text-sm">{copy.adminGlossaryEmpty}</p>
			) : (
				<table className="w-full border-collapse text-left text-sm">
					<thead>
						<tr className="border-ink-700 border-b text-ink-300">
							<th className="py-2 pr-4 font-semibold">
								{copy.adminGlossaryTerm}
							</th>
							<th className="py-2 pr-4 font-semibold">
								{copy.adminGlossaryTranslation}
							</th>
							<th className="py-2 pr-4 font-semibold">
								{copy.adminGlossaryNotes}
							</th>
							<th className="py-2 font-semibold">{copy.adminColActions}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr className="border-ink-700 border-b align-top" key={row.id}>
								<td className="py-2 pr-4 font-semibold text-ink-100">
									{row.term}
								</td>
								<td className="py-2 pr-4 text-ink-300">
									{row.translation ?? "—"}
								</td>
								<td className="py-2 pr-4 text-ink-300">{row.notes ?? "—"}</td>
								<td className="py-2">
									<div className="flex gap-2">
										<button
											className="text-cyan text-xs hover:underline"
											onClick={() => startEdit(row)}
											type="button"
										>
											{copy.adminEdit}
										</button>
										<button
											className="text-coral text-xs hover:underline"
											disabled={pending}
											onClick={() => remove.mutate({ id: row.id })}
											type="button"
										>
											{copy.adminDelete}
										</button>
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			<form
				className="mt-4 grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-3"
				onSubmit={submitTerm}
			>
				<label className="flex flex-col gap-1 text-ink-300 text-sm">
					{copy.adminGlossaryTerm}
					<input
						className={inputClass}
						onChange={(event) => setTerm(event.target.value)}
						required
						value={term}
					/>
				</label>
				<label className="flex flex-col gap-1 text-ink-300 text-sm">
					{copy.adminGlossaryTranslation}
					<input
						className={inputClass}
						onChange={(event) => setTranslation(event.target.value)}
						value={translation}
					/>
				</label>
				<label className="flex flex-col gap-1 text-ink-300 text-sm">
					{copy.adminGlossaryNotes}
					<input
						className={inputClass}
						onChange={(event) => setNotes(event.target.value)}
						value={notes}
					/>
				</label>
				<div className="flex gap-2">
					<button
						className="rounded-md bg-violet px-4 py-2 font-semibold text-ink-100 transition-colors hover:bg-violet-hover disabled:opacity-50"
						disabled={pending}
						type="submit"
					>
						{editingId ? copy.adminSaveSubmit : copy.adminTargetAdd}
					</button>
					{editingId && (
						<button
							className="rounded-md bg-ink-700 px-4 py-2 font-semibold text-ink-300"
							onClick={resetForm}
							type="button"
						>
							{copy.adminCancel}
						</button>
					)}
				</div>
			</form>
			<p className="mt-1 text-ink-500 text-xs">
				{copy.adminGlossaryTranslationHint}
			</p>

			<form className="mt-6 grid gap-2" onSubmit={submitBulk}>
				<label className="flex flex-col gap-1 text-ink-300 text-sm">
					{copy.adminGlossaryBulkLabel}
					<textarea
						className={`${inputClass} min-h-24 font-mono text-xs`}
						onChange={(event) => setBulkText(event.target.value)}
						placeholder={"Nerdearla\nkubectl = kube ctl"}
						value={bulkText}
					/>
				</label>
				<p className="text-ink-500 text-xs">{copy.adminGlossaryBulkHint}</p>
				<div>
					<button
						className="rounded-md border border-ink-700 px-4 py-2 font-semibold text-ink-300 transition-colors hover:border-ink-500 disabled:opacity-50"
						disabled={pending || !bulkText.trim()}
						type="submit"
					>
						{copy.adminGlossaryBulkSubmit}
					</button>
				</div>
			</form>

			{error && (
				<p className="mt-3 text-coral text-sm" role="alert">
					{copy.adminFormError} {error}
				</p>
			)}
		</div>
	);
}
