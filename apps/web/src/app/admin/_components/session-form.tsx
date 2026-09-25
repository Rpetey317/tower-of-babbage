"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
	deviceBackends,
	languages,
	roomColorClasses,
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
	streamUrl: string;
	deviceName: string;
	deviceBackend: string;
	browserMicHint: string;
	targetAdd: string;
	targetMoveUp: string;
	targetMoveDown: string;
	targetRemove: string;
	translationMode: string;
	createSubmit: string;
	saveSubmit: string;
	formError: string;
	delete: string;
	deleteConfirm: string;
}

const inputClass =
	"rounded-md border border-ink-700 bg-ink-800 px-3 py-2 text-ink-100 focus-visible:outline-2 focus-visible:outline-cyan";

function stringConfigValue(
	config: Record<string, unknown> | undefined,
	key: string,
	fallback = "",
): string {
	const value = config?.[key];
	return typeof value === "string" ? value : fallback;
}

/**
 * Create/edit session form. The slug auto-fills from the title until edited
 * manually; `sourceConfig` fields follow the per-type shapes documented in
 * docs/components/ingest.md and the first target language is the audience
 * default.
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
		stringConfigValue(initial?.sourceConfig, "path"),
	);
	const [replayLoop, setReplayLoop] = useState(
		initial?.sourceConfig?.loop === true,
	);
	const [streamUrl, setStreamUrl] = useState(
		stringConfigValue(initial?.sourceConfig, "url"),
	);
	const [deviceName, setDeviceName] = useState(
		stringConfigValue(initial?.sourceConfig, "device", "default"),
	);
	const [deviceBackend, setDeviceBackend] = useState(
		stringConfigValue(initial?.sourceConfig, "backend", "pulse"),
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

	function moveTarget(index: number, delta: number) {
		setTargetLanguages((current) => {
			const other = index + delta;
			const a = current[index];
			const b = current[other];
			if (a === undefined || b === undefined) return current;
			const next = [...current];
			next[index] = b;
			next[other] = a;
			return next;
		});
	}

	function sourceConfig(): Record<string, unknown> {
		switch (sourceType) {
			case "file_replay":
				return { path: replayPath, loop: replayLoop };
			case "stream_url":
				return { url: streamUrl };
			case "device":
				return { device: deviceName, backend: deviceBackend };
			default:
				return {};
		}
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
				<fieldset className="flex flex-col gap-1 text-ink-300 text-sm">
					<legend>{labels.roomColor}</legend>
					<div className="flex flex-wrap gap-1.5 py-1">
						{roomColors.map((color) => (
							<button
								aria-pressed={roomColor === color}
								className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs capitalize transition-colors ${
									roomColor === color
										? "border-cyan text-ink-100"
										: "border-ink-700 text-ink-300 hover:border-ink-500"
								}`}
								key={color}
								onClick={() => setRoomColor(color)}
								type="button"
							>
								<span
									aria-hidden="true"
									className={`h-3 w-3 rounded-full ${roomColorClasses[color]}`}
								/>
								{color}
							</button>
						))}
					</div>
				</fieldset>
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
					<ol className="flex flex-col gap-1 py-1">
						{targetLanguages.map((language, index) => (
							<li className="flex items-center gap-2" key={language}>
								<span className="w-4 text-ink-500 text-xs">{index + 1}.</span>
								<span className="min-w-8 font-semibold text-ink-100">
									{language}
								</span>
								<button
									aria-label={labels.targetMoveUp}
									className="rounded px-1.5 text-ink-300 hover:text-cyan disabled:opacity-30"
									disabled={index === 0}
									onClick={() => moveTarget(index, -1)}
									type="button"
								>
									↑
								</button>
								<button
									aria-label={labels.targetMoveDown}
									className="rounded px-1.5 text-ink-300 hover:text-cyan disabled:opacity-30"
									disabled={index === targetLanguages.length - 1}
									onClick={() => moveTarget(index, 1)}
									type="button"
								>
									↓
								</button>
								<button
									aria-label={labels.targetRemove}
									className="rounded px-1.5 text-ink-300 hover:text-coral"
									onClick={() =>
										setTargetLanguages((current) =>
											current.filter((item) => item !== language),
										)
									}
									type="button"
								>
									×
								</button>
							</li>
						))}
					</ol>
					<div className="flex flex-wrap gap-1.5">
						{languages
							.filter((language) => !targetLanguages.includes(language))
							.map((language) => (
								<button
									className="rounded-md border border-ink-700 px-2 py-1 text-ink-300 text-xs hover:border-ink-500"
									key={language}
									onClick={() =>
										setTargetLanguages((current) => [...current, language])
									}
									type="button"
								>
									{labels.targetAdd} {language}
								</button>
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
			{sourceType === "browser_mic" && (
				<p className="text-ink-500 text-sm">{labels.browserMicHint}</p>
			)}
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
			{sourceType === "stream_url" && (
				<label className="flex flex-col gap-1 text-ink-300 text-sm">
					{labels.streamUrl}
					<input
						className={inputClass}
						onChange={(event) => setStreamUrl(event.target.value)}
						placeholder="rtmp://…"
						required
						value={streamUrl}
					/>
				</label>
			)}
			{sourceType === "device" && (
				<div className="grid grid-cols-2 gap-4">
					<label className="flex flex-col gap-1 text-ink-300 text-sm">
						{labels.deviceName}
						<input
							className={inputClass}
							onChange={(event) => setDeviceName(event.target.value)}
							placeholder="default"
							required
							value={deviceName}
						/>
					</label>
					<label className="flex flex-col gap-1 text-ink-300 text-sm">
						{labels.deviceBackend}
						<select
							className={inputClass}
							onChange={(event) => setDeviceBackend(event.target.value)}
							value={deviceBackend}
						>
							{deviceBackends.map((backend) => (
								<option key={backend} value={backend}>
									{backend}
								</option>
							))}
						</select>
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
