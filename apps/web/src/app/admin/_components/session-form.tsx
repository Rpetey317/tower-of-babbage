"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
	languages,
	roomColors,
	slugify,
	sourceTypes,
	translationModes,
} from "~/lib/admin/options";
import { api } from "~/trpc/react";

export interface SessionFormValues {
	title: string;
	slug: string;
	room: string;
	roomColor: string;
	sourceLanguage: string;
	targetLanguages: string[];
	sourceType: string;
	sourceConfig: Record<string, unknown>;
	translationMode: string;
}

interface SessionFormLabels {
	title: string;
	slug: string;
	room: string;
	roomColor: string;
	sourceLanguage: string;
	targetLanguages: string;
	sourceType: string;
	replayPath: string;
	replayLoop: string;
	translationMode: string;
	createSubmit: string;
	saveSubmit: string;
	formError: string;
	delete: string;
	deleteConfirm: string;
}

const inputClass =
	"rounded-md border border-ink-700 bg-ink-800 px-3 py-2 text-ink-100 focus-visible:outline-2 focus-visible:outline-cyan";

/**
 * Create/edit session form (M1-05 minimal fields; the full per-type config
 * editor is M2-03). Slug auto-fills from the title until edited manually.
 */
export function SessionForm({
	mode,
	sessionId,
	initial,
	labels,
}: {
	mode: "create" | "edit";
	sessionId?: string;
	initial?: SessionFormValues;
	labels: SessionFormLabels;
}) {
	const router = useRouter();
	const [title, setTitle] = useState(initial?.title ?? "");
	const [slug, setSlug] = useState(initial?.slug ?? "");
	const [slugEdited, setSlugEdited] = useState(mode === "edit");
	const [room, setRoom] = useState(initial?.room ?? "");
	const [roomColor, setRoomColor] = useState(initial?.roomColor ?? "violet");
	const [sourceLanguage, setSourceLanguage] = useState(
		initial?.sourceLanguage ?? "en",
	);
	const [targetLanguages, setTargetLanguages] = useState<string[]>(
		initial?.targetLanguages ?? ["es"],
	);
	const [sourceType, setSourceType] = useState(
		initial?.sourceType ?? "browser_mic",
	);
	const [replayPath, setReplayPath] = useState(
		typeof initial?.sourceConfig?.path === "string"
			? initial.sourceConfig.path
			: "",
	);
	const [replayLoop, setReplayLoop] = useState(
		initial?.sourceConfig?.loop === true,
	);
	const [translationMode, setTranslationMode] = useState(
		initial?.translationMode ?? "ast",
	);
	const [error, setError] = useState<string | null>(null);

	const onSettled = () => router.refresh();
	const create = api.admin.sessions.create.useMutation({ onSettled });
	const update = api.admin.sessions.update.useMutation({ onSettled });
	const remove = api.admin.sessions.delete.useMutation({ onSettled });
	const pending = create.isPending || update.isPending || remove.isPending;

	function toggleTarget(language: string) {
		setTargetLanguages((current) =>
			current.includes(language)
				? current.filter((item) => item !== language)
				: [...current, language],
		);
	}

	function sourceConfig(): Record<string, unknown> {
		if (sourceType === "file_replay") {
			return { path: replayPath, loop: replayLoop };
		}
		return {};
	}

	function submit(event: React.FormEvent) {
		event.preventDefault();
		setError(null);
		const input = {
			title,
			slug,
			room,
			roomColor: roomColor as (typeof roomColors)[number],
			sourceLanguage,
			targetLanguages,
			sourceType: sourceType as (typeof sourceTypes)[number],
			sourceConfig: sourceConfig(),
			translationMode: translationMode as (typeof translationModes)[number],
		};
		const onError = (mutationError: { message: string }) =>
			setError(mutationError.message);
		if (mode === "create") {
			create.mutate(input, {
				onSuccess: (session) => {
					if (session) router.push(`/admin/sessions/${session.id}`);
				},
				onError,
			});
		} else if (sessionId) {
			update.mutate(
				{ id: sessionId, patch: input },
				{ onSuccess: () => router.refresh(), onError },
			);
		}
	}

	function confirmDelete() {
		if (!sessionId || !window.confirm(labels.deleteConfirm)) return;
		remove.mutate(
			{ id: sessionId },
			{
				onSuccess: () => router.push("/admin"),
				onError: (mutationError) => setError(mutationError.message),
			},
		);
	}

	return (
		<form className="mt-6 grid max-w-2xl gap-4" onSubmit={submit}>
			<label className="flex flex-col gap-1 text-ink-300 text-sm">
				{labels.title}
				<input
					className={inputClass}
					onChange={(event) => {
						setTitle(event.target.value);
						if (!slugEdited) setSlug(slugify(event.target.value));
					}}
					required
					value={title}
				/>
			</label>
			<label className="flex flex-col gap-1 text-ink-300 text-sm">
				{labels.slug}
				<input
					className={inputClass}
					onChange={(event) => {
						setSlugEdited(true);
						setSlug(event.target.value);
					}}
					pattern="[a-z0-9]+(-[a-z0-9]+)*"
					required
					value={slug}
				/>
			</label>
			<div className="grid grid-cols-2 gap-4">
				<label className="flex flex-col gap-1 text-ink-300 text-sm">
					{labels.room}
					<input
						className={inputClass}
						onChange={(event) => setRoom(event.target.value)}
						value={room}
					/>
				</label>
				<label className="flex flex-col gap-1 text-ink-300 text-sm">
					{labels.roomColor}
					<select
						className={inputClass}
						onChange={(event) => setRoomColor(event.target.value)}
						value={roomColor}
					>
						{roomColors.map((color) => (
							<option key={color} value={color}>
								{color}
							</option>
						))}
					</select>
				</label>
			</div>
			<div className="grid grid-cols-2 gap-4">
				<label className="flex flex-col gap-1 text-ink-300 text-sm">
					{labels.sourceLanguage}
					<select
						className={inputClass}
						onChange={(event) => setSourceLanguage(event.target.value)}
						value={sourceLanguage}
					>
						{languages.map((language) => (
							<option key={language} value={language}>
								{language}
							</option>
						))}
					</select>
				</label>
				<fieldset className="flex flex-col gap-1 text-ink-300 text-sm">
					<legend>{labels.targetLanguages}</legend>
					<div className="flex gap-3 py-2">
						{languages.map((language) => (
							<label className="flex items-center gap-1" key={language}>
								<input
									checked={targetLanguages.includes(language)}
									className="accent-cyan"
									onChange={() => toggleTarget(language)}
									type="checkbox"
								/>
								{language}
							</label>
						))}
					</div>
				</fieldset>
			</div>
			<div className="grid grid-cols-2 gap-4">
				<label className="flex flex-col gap-1 text-ink-300 text-sm">
					{labels.sourceType}
					<select
						className={inputClass}
						onChange={(event) => setSourceType(event.target.value)}
						value={sourceType}
					>
						{sourceTypes.map((type) => (
							<option key={type} value={type}>
								{type}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-ink-300 text-sm">
					{labels.translationMode}
					<select
						className={inputClass}
						onChange={(event) => setTranslationMode(event.target.value)}
						value={translationMode}
					>
						{translationModes.map((modeOption) => (
							<option key={modeOption} value={modeOption}>
								{modeOption}
							</option>
						))}
					</select>
				</label>
			</div>
			{sourceType === "file_replay" && (
				<div className="grid grid-cols-2 items-end gap-4">
					<label className="flex flex-col gap-1 text-ink-300 text-sm">
						{labels.replayPath}
						<input
							className={inputClass}
							onChange={(event) => setReplayPath(event.target.value)}
							placeholder="en-kubernetes-60s.wav"
							required
							value={replayPath}
						/>
					</label>
					<label className="flex items-center gap-2 py-2 text-ink-300 text-sm">
						<input
							checked={replayLoop}
							className="accent-cyan"
							onChange={(event) => setReplayLoop(event.target.checked)}
							type="checkbox"
						/>
						{labels.replayLoop}
					</label>
				</div>
			)}
			{error && (
				<p className="text-coral text-sm" role="alert">
					{labels.formError} {error}
				</p>
			)}
			<div className="flex items-center gap-3">
				<button
					className="rounded-md bg-violet px-4 py-2 font-semibold text-ink-100 transition-colors hover:bg-violet-hover disabled:opacity-50"
					disabled={pending || targetLanguages.length === 0}
					type="submit"
				>
					{mode === "create" ? labels.createSubmit : labels.saveSubmit}
				</button>
				{mode === "edit" && (
					<button
						className="rounded-md bg-coral px-4 py-2 font-semibold text-ink-950 transition-opacity disabled:opacity-50"
						disabled={pending}
						onClick={confirmDelete}
						type="button"
					>
						{labels.delete}
					</button>
				)}
			</div>
		</form>
	);
}
