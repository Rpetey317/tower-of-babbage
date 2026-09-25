"use client";

import { useEffect, useReducer } from "react";

import {
	type CaptionSegment,
	captionsReducer,
	chunkSpeaker,
	chunkText,
	createCaptionsState,
	type SessionStatus,
	sortedChunks,
} from "~/lib/captions";
import type { OverlayParams } from "~/lib/overlay";
import { speakerTextClass } from "~/lib/speakers";
import { api } from "~/trpc/react";

export interface OverlaySession {
	id: string;
	sourceLanguage: string;
	status: SessionStatus;
}

export function OverlayView({
	session,
	params,
	initialSegments,
}: {
	session: OverlaySession;
	params: OverlayParams;
	initialSegments: CaptionSegment[];
}) {
	const [state, dispatch] = useReducer(captionsReducer, undefined, () =>
		createCaptionsState({
			segments: initialSegments,
			sessionStatus: session.status,
		}),
	);

	// Same backfill as the audience view: covers segments missed during a
	// reconnect gap that the subscription's lastEventId catch-up skipped.
	const recent = api.segments.recent.useQuery(
		{ sessionId: session.id, languages: params.languages },
		{ initialData: initialSegments },
	);
	useEffect(() => {
		if (recent.data) {
			dispatch({ type: "merge", segments: recent.data });
		}
	}, [recent.data]);

	const subscription = api.segments.onSegment.useSubscription(
		{ sessionId: session.id, languages: params.languages },
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

	// Silent reconnect and "empty when not live": the overlay never renders
	// status or error text, it just stops painting.
	const live =
		(state.sessionStatus === "running" || state.sessionStatus === "starting") &&
		subscription.status === "pending";

	const lines = sortedChunks(state)
		.flatMap((chunk) => {
			const text = chunkText({
				chunk,
				mode: params.mode,
				language: params.language,
				sourceLanguage: session.sourceLanguage,
			});
			const speaker = chunkSpeaker(chunk);
			const accent = speaker ? speakerTextClass(speaker) : undefined;
			const entries: {
				key: string;
				text: string;
				lang: string;
				muted: boolean;
				accent?: string;
			}[] = [];
			if (text.original !== undefined) {
				entries.push({
					key: `${chunk.chunkIndex}-o`,
					text: text.original,
					lang: session.sourceLanguage,
					muted: text.translation !== undefined,
					accent,
				});
			}
			if (text.translation !== undefined) {
				entries.push({
					key: `${chunk.chunkIndex}-t`,
					text: text.translation,
					lang: params.language,
					muted: false,
					accent,
				});
			}
			return entries;
		})
		.slice(-params.lines);

	if (!live || lines.length === 0) {
		return null;
	}

	return (
		<div
			className="fixed inset-0 cursor-none overflow-hidden font-caption text-ink-100"
			style={{
				display: "flex",
				flexDirection: "column",
				fontSize: `calc(${params.size} * 100vw / 1920)`,
				justifyContent: params.align === "top" ? "flex-start" : "flex-end",
				lineHeight: 1.35,
				padding: `calc(${params.margin} * 100vw / 1920)`,
			}}
		>
			<div
				className={`mx-auto w-full max-w-[42ch] overflow-hidden ${
					params.bg === "band" ? "bg-ink-900/80" : ""
				}`}
				style={{
					display: "flex",
					flexDirection: "column",
					justifyContent: "flex-end",
					maxHeight: `${params.lines * 1.35}em`,
				}}
			>
				{lines.map((line) => (
					<p
						className={`overlay-outline ${
							line.muted ? "text-ink-300" : (line.accent ?? "")
						} ${params.fade ? "overlay-fade" : ""}`}
						key={line.key}
						lang={line.lang}
					>
						{params.bg === "box" ? (
							<span className="bg-ink-900/80 box-decoration-clone px-[0.35em]">
								{line.text}
							</span>
						) : (
							line.text
						)}
					</p>
				))}
			</div>
		</div>
	);
}
