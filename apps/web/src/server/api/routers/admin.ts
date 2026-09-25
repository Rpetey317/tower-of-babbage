import { randomUUID } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { asc, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { env } from "~/env";
import { roomColors, sourceTypes } from "~/lib/admin/options";
import {
	contractVersion,
	sessionStartRequestSchema,
	sessionStopRequestSchema,
} from "~/lib/contract";
import { mintIngestToken } from "~/lib/contract/token.server";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { glossaryTerms, sessions } from "~/server/db/schema";
import { latestStats } from "~/server/events/state";

const uuid = z.string().uuid();
const language = z.string().regex(/^[a-z]{2,8}$/);
const slug = z
	.string()
	.regex(
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
		"Lowercase letters, digits and hyphens only",
	);

const sessionInputSchema = z.object({
	title: z.string().min(1),
	slug,
	room: z.string().default(""),
	roomColor: z.enum(roomColors).default("violet"),
	sourceLanguage: language,
	targetLanguages: z.array(language).min(1),
	sourceType: z.enum(sourceTypes),
	sourceConfig: z.record(z.unknown()).default({}),
	translationMode: z.enum(["ast", "asr_then_text"]).default("ast"),
});

type Session = typeof sessions.$inferSelect;

/** Session glossary terms first, then global ones (sessionId null). */
async function mergedGlossary(sessionId: string) {
	const terms = await db
		.select({
			term: glossaryTerms.term,
			translation: glossaryTerms.translation,
		})
		.from(glossaryTerms)
		.where(
			or(
				eq(glossaryTerms.sessionId, sessionId),
				isNull(glossaryTerms.sessionId),
			),
		)
		.orderBy(asc(glossaryTerms.sessionId), asc(glossaryTerms.createdAt));
	return terms;
}

function toStartRequest(
	session: Session,
	runId: string,
	glossary: { term: string; translation: string | null }[],
) {
	return sessionStartRequestSchema.parse({
		contractVersion,
		runId,
		slug: session.slug,
		sourceLanguage: session.sourceLanguage,
		targetLanguages: session.targetLanguages,
		translationMode: session.translationMode,
		source: { type: session.sourceType, config: session.sourceConfig },
		glossary,
	});
}

async function postPipeline(
	path: string,
	body: unknown,
): Promise<{ ok: boolean; status: number; detail: string }> {
	const response = await fetch(`${env.PIPELINE_URL}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.SHARED_SECRET}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const detail = await response.text().catch(() => "");
	return { ok: response.ok, status: response.status, detail };
}

/** Mark the session error with the pipeline failure detail. */
async function markError(sessionId: string, message: string) {
	await db
		.update(sessions)
		.set({ status: "error", lastError: message, updatedAt: new Date() })
		.where(eq(sessions.id, sessionId));
}

export const adminRouter = createTRPCRouter({
	sessions: createTRPCRouter({
		list: protectedProcedure.query(async () => {
			const rows = await db
				.select()
				.from(sessions)
				.orderBy(desc(sessions.createdAt), asc(sessions.id));
			return rows.map((session) => ({
				...session,
				stats: latestStats(session.id) ?? null,
			}));
		}),

		byId: protectedProcedure
			.input(z.object({ id: uuid }))
			.query(async ({ input }) => {
				const [session] = await db
					.select()
					.from(sessions)
					.where(eq(sessions.id, input.id));
				if (!session) {
					throw new TRPCError({ code: "NOT_FOUND" });
				}
				return { ...session, stats: latestStats(session.id) ?? null };
			}),

		create: protectedProcedure
			.input(sessionInputSchema)
			.mutation(async ({ input }) => {
				try {
					const [session] = await db.insert(sessions).values(input).returning();
					return session;
				} catch (error) {
					if (
						error instanceof Error &&
						error.message.includes("sessions_slug")
					) {
						throw new TRPCError({
							code: "CONFLICT",
							message: "slug_taken",
						});
					}
					throw error;
				}
			}),

		update: protectedProcedure
			.input(z.object({ id: uuid, patch: sessionInputSchema.partial() }))
			.mutation(async ({ input }) => {
				const [session] = await db
					.update(sessions)
					.set({ ...input.patch, updatedAt: new Date() })
					.where(eq(sessions.id, input.id))
					.returning();
				if (!session) {
					throw new TRPCError({ code: "NOT_FOUND" });
				}
				return session;
			}),

		delete: protectedProcedure
			.input(z.object({ id: uuid }))
			.mutation(async ({ input }) => {
				const [session] = await db
					.select({ status: sessions.status })
					.from(sessions)
					.where(eq(sessions.id, input.id));
				if (!session) {
					throw new TRPCError({ code: "NOT_FOUND" });
				}
				if (["starting", "running", "stopping"].includes(session.status)) {
					throw new TRPCError({
						code: "CONFLICT",
						message: `cannot delete a ${session.status} session`,
					});
				}
				await db.delete(sessions).where(eq(sessions.id, input.id));
				return { deleted: true };
			}),

		start: protectedProcedure
			.input(z.object({ id: uuid }))
			.mutation(async ({ input }) => {
				const [session] = await db
					.select()
					.from(sessions)
					.where(eq(sessions.id, input.id));
				if (!session) {
					throw new TRPCError({ code: "NOT_FOUND" });
				}
				if (session.status === "stopping") {
					throw new TRPCError({
						code: "CONFLICT",
						message: "session is stopping",
					});
				}
				// Idempotent: a running or starting run is the current run.
				if (
					(session.status === "running" || session.status === "starting") &&
					session.currentRunId
				) {
					return { runId: session.currentRunId, status: session.status };
				}

				const runId = randomUUID();
				const body = toStartRequest(
					session,
					runId,
					await mergedGlossary(session.id),
				);
				await db
					.update(sessions)
					.set({
						status: "starting",
						currentRunId: runId,
						startedAt: new Date(),
						stoppedAt: null,
						lastError: null,
						updatedAt: new Date(),
					})
					.where(eq(sessions.id, session.id));

				try {
					const result = await postPipeline(
						`/v1/sessions/${session.id}/start`,
						body,
					);
					if (!result.ok) {
						throw new Error(
							`pipeline ${result.status}${
								result.detail ? `: ${result.detail}` : ""
							}`,
						);
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					await markError(session.id, message);
					return { runId, status: "error" as const };
				}
				return { runId, status: "starting" as const };
			}),

		stop: protectedProcedure
			.input(z.object({ id: uuid }))
			.mutation(async ({ input }) => {
				const [session] = await db
					.select()
					.from(sessions)
					.where(eq(sessions.id, input.id));
				if (!session) {
					throw new TRPCError({ code: "NOT_FOUND" });
				}
				if (
					session.status === "idle" ||
					session.status === "stopping" ||
					(session.status === "error" && !session.currentRunId)
				) {
					return { runId: session.currentRunId, status: session.status };
				}

				// An error session may still hold a run on the pipeline (e.g.
				// the watchdog timed it out), so stop is allowed for it too.
				await db
					.update(sessions)
					.set({ status: "stopping", updatedAt: new Date() })
					.where(eq(sessions.id, session.id));

				try {
					const result = await postPipeline(
						`/v1/sessions/${session.id}/stop`,
						sessionStopRequestSchema.parse({
							runId: session.currentRunId,
						}),
					);
					if (!result.ok && result.status !== 404) {
						throw new Error(
							`pipeline ${result.status}${
								result.detail ? `: ${result.detail}` : ""
							}`,
						);
					}
					if (result.status === 404) {
						// The pipeline holds no such run, so no status event will
						// arrive to flip the session; re-arm it directly.
						await db
							.update(sessions)
							.set({
								status: "idle",
								lastError: null,
								stoppedAt: new Date(),
								updatedAt: new Date(),
							})
							.where(eq(sessions.id, session.id));
						return {
							runId: session.currentRunId,
							status: "idle" as const,
						};
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					await markError(session.id, message);
					return { runId: session.currentRunId, status: "error" as const };
				}
				return { runId: session.currentRunId, status: "stopping" as const };
			}),
	}),

	ingestToken: protectedProcedure
		.input(z.object({ sessionId: uuid }))
		.mutation(async ({ input }) => {
			const [session] = await db
				.select({ id: sessions.id })
				.from(sessions)
				.where(eq(sessions.id, input.sessionId));
			if (!session) {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
			return { token: mintIngestToken(input.sessionId, env.SHARED_SECRET) };
		}),
});
