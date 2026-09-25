"use client";

import Link from "next/link";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
	ConnectionPill,
	type PillKind,
} from "~/app/_components/connection-pill";
import { RoomDot, roomColorClass } from "~/app/(audience)/_components/room-dot";
import {
	type CaptionMode,
	type CaptionSegment,
	captionsReducer,
	chunkSpeaker,
	chunkText,
	createCaptionsState,
	resolveCaptionView,
	type SessionStatus,
	sortedChunks,
} from "~/lib/captions";
import { getDictionary } from "~/lib/i18n";
import type { Locale } from "~/lib/i18n/locale";
import { speakerName, speakerTextClass } from "~/lib/speakers";
import { api } from "~/trpc/react";

const visibleChunks = 8;
const fontSizeKey = "tob_caption_px";
const minFontPx = 16;
const maxFontPx = 48;
const fontStepPx = 2;
const bottomSlackPx = 40;

export interface CaptionSession {
	id: string;
	slug: string;
	title: string;
	room: string;
	roomColor: string;
	sourceLanguage: string;
	targetLanguages: string[];
	status: SessionStatus;
}

function clampFontPx(value: number): number {
	return Math.min(maxFontPx, Math.max(minFontPx, Math.round(value)));
}

function defaultFontPx(): number {
	return window.matchMedia("(min-width: 768px)").matches ? 28 : 22;
}

export function CaptionView({
	session,
	initialLanguage,
	initialMode,
	initialSegments,
	locale,
}: {
	session: CaptionSession;
	initialLanguage: string;
	initialMode: CaptionMode;
	initialSegments: CaptionSegment[];
	locale: Locale;
}) {
	const copy = getDictionary(locale);
	const [language, setLanguage] = useState(initialLanguage);
	const [mode, setMode] = useState(initialMode);
	const languages = useMemo(
		() =>
			resolveCaptionView({
				sourceLanguage: session.sourceLanguage,
				targetLanguages: session.targetLanguages,
				lang: language,
				mode,
			}).languages,
		[session.sourceLanguage, session.targetLanguages, language, mode],
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

	// Backfills chunks the live subscription did not cover: segments in a
	// language selected for the first time, or emitted during a reconnect.
	const recent = api.segments.recent.useQuery(
		{ sessionId: session.id, languages },
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
			// Tracked events arrive as `{ id, data }`; keepalive pings are
			// dropped by the type check below.
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

	const [fontPx, setFontPx] = useState<number | null>(null);
	useEffect(() => {
		const raw = window.localStorage.getItem(fontSizeKey);
		if (raw !== null && Number.isFinite(Number(raw))) {
			setFontPx(clampFontPx(Number(raw)));
		}
	}, []);
	useEffect(() => {
		if (fontPx !== null) {
			window.localStorage.setItem(fontSizeKey, String(fontPx));
		}
	}, [fontPx]);

	const chunks = sortedChunks(state).slice(-visibleChunks);
	const atBottomRef = useRef(true);
	const [showJump, setShowJump] = useState(false);
	useEffect(() => {
		const onScroll = () => {
			const atBottom =
				window.innerHeight + window.scrollY >=
				document.documentElement.scrollHeight - bottomSlackPx;
			atBottomRef.current = atBottom;
			setShowJump(!atBottom);
		};
		onScroll();
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);
	// Runs after every commit: new chunks, font changes and reconnects all
	// re-pin the scroll while the user is at the bottom.
	useEffect(() => {
		if (atBottomRef.current) {
			window.scrollTo({
				top: document.documentElement.scrollHeight,
				behavior: "auto",
			});
		}
	});

	function jumpToLive() {
		const reduced = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		atBottomRef.current = true;
		setShowJump(false);
		window.scrollTo({
			top: document.documentElement.scrollHeight,
			behavior: reduced ? "auto" : "smooth",
		});
	}

	const languageOptions = [session.sourceLanguage, ...session.targetLanguages];
	const modeOptions: { value: CaptionMode; label: string }[] = [
		{ value: "translation", label: copy.modeTranslation },
		{ value: "original", label: copy.modeOriginal },
		{ value: "both", label: copy.modeBoth },
	];

	return (
		<div className="print:bg-white">
			<header className="print:hidden">
				<div className={`h-[3px] ${roomColorClass(session.roomColor)}`} />
				<div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-4 gap-y-3 px-4 pt-4">
					<Link
						className="text-ink-300 text-sm underline-offset-4 hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-cyan focus-visible:outline-offset-2"
						href="/"
					>
						{copy.backToSessions}
					</Link>
					<ConnectionPill kind={pillKind} label={pillLabel} />
				</div>
				<div className="mx-auto flex max-w-4xl flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-2">
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
				<div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4">
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
					<fieldset className="inline-flex rounded-md border border-ink-700 p-1">
						<legend className="sr-only">{copy.fontSizeLabel}</legend>
						<button
							aria-label={copy.fontSizeDecrease}
							className="rounded px-3 py-1 font-semibold text-ink-300 text-sm transition-colors hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-cyan focus-visible:outline-offset-2 disabled:opacity-40"
							disabled={fontPx !== null && fontPx <= minFontPx}
							onClick={() =>
								setFontPx((prev) =>
									clampFontPx((prev ?? defaultFontPx()) - fontStepPx),
								)
							}
							type="button"
						>
							A−
						</button>
						<button
							aria-label={copy.fontSizeIncrease}
							className="rounded px-3 py-1 font-semibold text-ink-300 text-sm transition-colors hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-cyan focus-visible:outline-offset-2 disabled:opacity-40"
							disabled={fontPx !== null && fontPx >= maxFontPx}
							onClick={() =>
								setFontPx((prev) =>
									clampFontPx((prev ?? defaultFontPx()) + fontStepPx),
								)
							}
							type="button"
						>
							A+
						</button>
					</fieldset>
				</div>
			</header>
			<main className="mx-auto max-w-4xl px-4 pb-24">
				{state.restarted && state.chunks.size === 0 ? (
					<p className="py-16 text-center text-ink-300">
						{copy.sessionRestarted}
					</p>
				) : chunks.length === 0 ? (
					<p className="py-16 text-center text-ink-300">
						{copy.waitingForCaptions}
					</p>
				) : (
					<ol
						className="space-y-6 py-6 font-caption text-[22px] leading-[1.35] md:text-[28px]"
						style={{
							fontSize: fontPx === null ? undefined : fontPx,
						}}
					>
						{chunks.map((chunk, index) => {
							const text = chunkText({
								chunk,
								mode,
								language,
								sourceLanguage: session.sourceLanguage,
							});
							if (
								text.original === undefined &&
								text.translation === undefined
							) {
								return null;
							}
							const isNewest = index === chunks.length - 1;
							const speaker = chunkSpeaker(chunk);
							const accent = speaker ? speakerTextClass(speaker) : undefined;
							return (
								<li
									aria-live={isNewest ? "polite" : undefined}
									key={chunk.chunkIndex}
								>
									{speaker !== undefined && (
										<p
											className={`font-sans font-semibold text-[0.55em] uppercase tracking-widest ${accent} print:text-black`}
										>
											{speakerName(speaker, copy.speakerLabel)}
										</p>
									)}
									{text.original !== undefined && (
										<p
											className={`${accent ?? (text.translation !== undefined ? "text-ink-300" : "text-ink-100")} print:text-black`}
											lang={session.sourceLanguage}
										>
											{text.original}
										</p>
									)}
									{text.translation !== undefined && (
										<p
											className={`${accent ?? "text-ink-100"} print:text-black`}
											lang={language}
										>
											{text.translation}
										</p>
									)}
								</li>
							);
						})}
					</ol>
				)}
			</main>
			{showJump && (
				<button
					className="fixed inset-x-0 bottom-6 mx-auto w-fit rounded-full border border-cyan/40 bg-ink-800 px-4 py-2 font-semibold text-cyan text-sm focus-visible:outline-2 focus-visible:outline-cyan focus-visible:outline-offset-2 print:hidden"
					onClick={jumpToLive}
					type="button"
				>
					{copy.jumpToLive}
				</button>
			)}
		</div>
	);
}
