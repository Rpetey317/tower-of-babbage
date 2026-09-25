"use client";

import Link from "next/link";
import { useEffect, useMemo, useReducer, useState } from "react";

import {
	ConnectionPill,
	type PillKind,
} from "~/app/_components/connection-pill";
import { RoomDot, roomColorClass } from "~/app/(audience)/_components/room-dot";
import {
	type CaptionMode,
	type CaptionSegment,
	captionsReducer,
	chunkText,
	createCaptionsState,
	type SessionStatus,
	sortedChunks,
} from "~/lib/captions";
import { getDictionary } from "~/lib/i18n";
import type { Locale } from "~/lib/i18n/locale";
import { cueAt } from "~/lib/playback";
import { api } from "~/trpc/react";

export interface PlaybackSession {
	id: string;
	slug: string;
	title: string;
	room: string;
	roomColor: string;
	sourceLanguage: string;
	targetLanguages: string[];
	status: SessionStatus;
}

/**
 * `/s/[slug]/play`: the video a `file_replay` session replays with its
 * captions overlaid in sync. Segments carry media-time `startMs`/`endMs`,
 * so `video.currentTime` selects the cue; pause and seek work without any
 * extra coordination (docs/components/playback.md).
 */
export function PlaybackView({
	session,
	mediaUrl,
	initialLanguage,
	initialMode,
	initialSegments,
	locale,
}: {
	session: PlaybackSession;
	mediaUrl: string | null;
	initialLanguage: string;
	initialMode: CaptionMode;
	initialSegments: CaptionSegment[];
	locale: Locale;
}) {
	const copy = getDictionary(locale);
	const [language, setLanguage] = useState(initialLanguage);
	const [mode, setMode] = useState(initialMode);
	// All session languages: the subscription and backfill cover every mode
	// so the language switch never waits on a refetch.
	const languages = useMemo(
		() => [...new Set([session.sourceLanguage, ...session.targetLanguages])],
		[session.sourceLanguage, session.targetLanguages],
	);
	const [state, dispatch] = useReducer(captionsReducer, undefined, () =>
		createCaptionsState({
			segments: initialSegments,
			sessionStatus: session.status,
		}),
	);

	function syncUrl(nextLanguage: string, nextMode: CaptionMode) {
		const url = new URL(window.location.href);
		url.searchParams.set("lang", nextLanguage);
		url.searchParams.set("mode", nextMode);
		window.history.replaceState(null, "", url);
	}

	const recent = api.segments.recent.useQuery(
		{ sessionId: session.id, languages, limit: 200 },
		{ initialData: initialSegments },
	);
	useEffect(() => {
		if (recent.data) {
			dispatch({ type: "merge", segments: recent.data });
		}
	}, [recent.data]);

	const subscription = api.segments.onSegment.useSubscription(
		{ sessionId: session.id, languages },
		{
			onData: (item) => {
				const event = item.data;
				if (event.type === "segment") {
					dispatch({ type: "segment", segment: event });
				} else if (event.type === "status") {
					dispatch({ type: "status", status: event });
				}
			},
		},
	);

	const sessionLive =
		state.sessionStatus === "running" || state.sessionStatus === "starting";
	const pillKind: PillKind = sessionLive
		? subscription.status === "pending"
			? "live"
			: "reconnecting"
		: "notlive";
	const pillLabel =
		pillKind === "live"
			? copy.connLive
			: pillKind === "reconnecting"
				? copy.connReconnecting
				: copy.connNotLive;

	const [timeMs, setTimeMs] = useState(0);
	const chunks = sortedChunks(state);
	const cue = cueAt(chunks, timeMs);
	const text = cue
		? chunkText({
				chunk: cue,
				mode,
				language,
				sourceLanguage: session.sourceLanguage,
			})
		: {};
	const cueVisible =
		text.original !== undefined || text.translation !== undefined;

	const languageOptions = [session.sourceLanguage, ...session.targetLanguages];
	const modeOptions: { value: CaptionMode; label: string }[] = [
		{ value: "translation", label: copy.modeTranslation },
		{ value: "original", label: copy.modeOriginal },
		{ value: "both", label: copy.modeBoth },
	];

	return (
		<div>
			<header>
				<div className={`h-[3px] ${roomColorClass(session.roomColor)}`} />
				<div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-3 px-4 pt-4">
					<Link
						className="text-ink-300 text-sm underline-offset-4 hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-cyan focus-visible:outline-offset-2"
						href={`/s/${session.slug}`}
					>
						{copy.playbackCaptionLink}
					</Link>
					<ConnectionPill kind={pillKind} label={pillLabel} />
				</div>
				<div className="mx-auto flex max-w-5xl flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-2">
					<h1 className="font-display text-3xl uppercase tracking-wide">
						{session.title}
					</h1>
					{session.room !== "" && (
						<span className="flex items-center gap-2 text-ink-300 text-sm">
							<RoomDot roomColor={session.roomColor} />
							{session.room}
						</span>
					)}
				</div>
				<div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4">
					<fieldset className="inline-flex rounded-md border border-ink-700 p-1">
						<legend className="sr-only">{copy.captionLangLabel}</legend>
						{languageOptions.map((option) => (
							<button
								aria-pressed={language === option}
								className="rounded px-3 py-1 font-semibold text-ink-300 text-sm transition-colors hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-cyan focus-visible:outline-offset-2 aria-pressed:bg-cyan aria-pressed:text-ink-950"
								key={option}
								onClick={() => {
									setLanguage(option);
									syncUrl(option, mode);
								}}
								type="button"
							>
								{option.toUpperCase()}
							</button>
						))}
					</fieldset>
					<fieldset className="inline-flex rounded-md border border-ink-700 p-1">
						<legend className="sr-only">{copy.modeLabel}</legend>
						{modeOptions.map((option) => (
							<button
								aria-pressed={mode === option.value}
								className="rounded px-3 py-1 font-semibold text-ink-300 text-sm transition-colors hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-cyan focus-visible:outline-offset-2 aria-pressed:bg-cyan aria-pressed:text-ink-950"
								key={option.value}
								onClick={() => {
									setMode(option.value);
									syncUrl(language, option.value);
								}}
								type="button"
							>
								{option.label}
							</button>
						))}
					</fieldset>
				</div>
			</header>
			<main className="mx-auto max-w-5xl px-4 pb-12">
				{mediaUrl === null ? (
					<p className="py-16 text-center text-ink-300">
						{copy.playbackNoVideo}
					</p>
				) : (
					<>
						<div className="relative">
							{/* biome-ignore lint/a11y/useMediaCaption: captions are rendered live by the overlay below, not a static <track> */}
							<video
								aria-label={copy.playbackVideoLabel}
								className="aspect-video w-full bg-black"
								controls
								onTimeUpdate={(event) =>
									setTimeMs(event.currentTarget.currentTime * 1000)
								}
								playsInline
								preload="auto"
								src={mediaUrl}
							/>
							{cueVisible && (
								<div className="pointer-events-none absolute inset-x-0 bottom-14 flex justify-center px-6">
									<div className="rounded bg-ink-950/80 px-4 py-2 text-center font-caption text-ink-100 text-lg leading-snug md:text-2xl">
										{text.original !== undefined && (
											<p
												className={
													text.translation !== undefined
														? "text-ink-300"
														: "text-ink-100"
												}
												lang={session.sourceLanguage}
											>
												{text.original}
											</p>
										)}
										{text.translation !== undefined && (
											<p className="text-ink-100" lang={language}>
												{text.translation}
											</p>
										)}
									</div>
								</div>
							)}
						</div>
						{state.chunks.size === 0 && (
							<p className="py-6 text-center text-ink-300">
								{copy.waitingForCaptions}
							</p>
						)}
					</>
				)}
			</main>
		</div>
	);
}
