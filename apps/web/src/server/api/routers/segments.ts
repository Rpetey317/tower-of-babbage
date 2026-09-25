import { TRPCError, tracked } from "@trpc/server";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Event } from "~/lib/contract";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { segments, sessions } from "~/server/db/schema";
import { subscribe } from "~/server/events/bus";

export type SegmentEvent = Extract<Event, { type: "segment" }>;
export type StatusEvent = Extract<Event, { type: "status" }>;

const language = z.string().regex(/^[a-z]{2,8}$/);

const keepaliveMs = 15_000;

/**
 * SSE `lastEventId` encoding: `<runId>:<chunkIndex>:<language>` for segments,
 * `<runId>:status` for status items. Catch-up only replays segments, so the
 * parser returns just `runId` and `chunkIndex` (-1 for status, meaning
 * "replay the run from the start").
 */
export function segmentEventId(event: {
	runId: string;
	chunkIndex: number;
	language: string;
}): string {
	return `${event.runId}:${event.chunkIndex}:${event.language}`;
}

export function statusEventId(runId: string): string {
	return `${runId}:status`;
}

export function parseSegmentEventId(
	lastEventId: string,
): { runId: string; chunkIndex: number } | null {
	const parts = lastEventId.split(":");
	if (parts.length === 2 && parts[1] === "status") {
		return { runId: parts[0] as string, chunkIndex: -1 };
	}
	const chunkIndex = Number(parts[1]);
	if (parts.length !== 3 || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
		return null;
	}
	return { runId: parts[0] as string, chunkIndex };
}

function rowToSegmentEvent(row: typeof segments.$inferSelect): SegmentEvent {
	return {
		type: "segment",
		sessionId: row.sessionId,
		runId: row.runId,
		chunkIndex: row.chunkIndex,
		kind: row.kind,
		language: row.language,
		text: row.text,
		speaker: row.speaker ?? undefined,
		isFinal: row.isFinal,
		startMs: row.startMs,
		endMs: row.endMs,
		emittedAt: row.emittedAt.toISOString(),
		latencyMs: row.latencyMs,
	};
}

/** Segments of `runId` after `afterChunkIndex`, for `lastEventId` catch-up. */
export async function catchUpSegments(opts: {
	sessionId: string;
	runId: string;
	afterChunkIndex: number;
	languages: string[];
}): Promise<SegmentEvent[]> {
	const rows = await db
		.select()
		.from(segments)
		.where(
			and(
				eq(segments.sessionId, opts.sessionId),
				eq(segments.runId, opts.runId),
				gt(segments.chunkIndex, opts.afterChunkIndex),
				inArray(segments.language, opts.languages),
			),
		)
		.orderBy(asc(segments.chunkIndex), asc(segments.language));
	return rows.map(rowToSegmentEvent);
}

const subscriptionInput = z.object({
	sessionId: z.string().uuid(),
	languages: z.array(language).min(1),
	lastEventId: z.string().optional(),
});

export const segmentsRouter = createTRPCRouter({
	recent: publicProcedure
		.input(
			z.object({
				sessionId: z.string().uuid(),
				languages: z.array(language).min(1),
				limit: z.number().int().positive().max(200).default(50),
			}),
		)
		.query(async ({ input }) => {
			const [session] = await db
				.select({ currentRunId: sessions.currentRunId })
				.from(sessions)
				.where(eq(sessions.id, input.sessionId))
				.limit(1);
			if (!session) {
				throw new TRPCError({ code: "NOT_FOUND" });
			}

			let runId = session.currentRunId;
			if (!runId) {
				// No active run: fall back to the most recent one with segments.
				const [latest] = await db
					.select({ runId: segments.runId })
					.from(segments)
					.where(eq(segments.sessionId, input.sessionId))
					.orderBy(desc(segments.emittedAt))
					.limit(1);
				runId = latest?.runId ?? null;
			}
			if (!runId) return [];

			const rows = await db
				.select()
				.from(segments)
				.where(
					and(
						eq(segments.sessionId, input.sessionId),
						eq(segments.runId, runId),
						inArray(segments.language, input.languages),
					),
				)
				.orderBy(desc(segments.chunkIndex), desc(segments.language))
				.limit(input.limit);
			return rows.reverse().map(rowToSegmentEvent);
		}),

	onSegment: publicProcedure
		.input(subscriptionInput)
		.subscription(async function* ({ input, signal }) {
			if (input.lastEventId) {
				const last = parseSegmentEventId(input.lastEventId);
				if (last) {
					const missed = await catchUpSegments({
						sessionId: input.sessionId,
						runId: last.runId,
						afterChunkIndex: last.chunkIndex,
						languages: input.languages,
					});
					for (const segment of missed) {
						yield tracked(segmentEventId(segment), segment);
					}
				}
			}

			// Fan the two bus topics into one queue; a timer pings every
			// keepaliveMs so proxies do not drop an idle SSE stream.
			type Item = Event | { type: "ping" };
			const ping: Item = { type: "ping" };
			const queue: Item[] = [];
			let wake: (() => void) | undefined;
			const push = (item: Item) => {
				queue.push(item);
				wake?.();
			};

			const iterators = [
				subscribe(`segments:${input.sessionId}`),
				subscribe(`status:${input.sessionId}`),
			].map((iterable) => iterable[Symbol.asyncIterator]());
			const pumps = iterators.map((iterator) =>
				(async () => {
					for (;;) {
						const { done, value } = await iterator.next();
						if (done) return;
						push(value);
					}
				})(),
			);
			const timer = setInterval(() => push(ping), keepaliveMs);
			timer.unref?.();

			try {
				for (;;) {
					if (signal?.aborted) return;
					if (queue.length === 0) {
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
						wake = undefined;
						continue;
					}
					const item = queue.shift() as Item;
					if (item.type === "ping") {
						yield tracked("ping", { type: "ping" } as const);
					} else if (item.type === "segment") {
						if (input.languages.includes(item.language)) {
							yield tracked(segmentEventId(item), item);
						}
					} else if (item.type === "status") {
						yield tracked(statusEventId(item.runId), item);
					}
				}
			} finally {
				clearInterval(timer);
				for (const iterator of iterators) {
					await iterator.return?.();
				}
				await Promise.allSettled(pumps);
			}
		}),
});
