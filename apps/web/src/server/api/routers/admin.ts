import { randomUUID } from "node:crypto";

import { TRPCError, tracked } from "@trpc/server";
import { asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { env } from "~/env";
import { mergeGlossary, parseBulkPaste } from "~/lib/admin/glossary";
import { deviceBackends, roomColors, sourceTypes } from "~/lib/admin/options";
import {
	contractVersion,
	type Event,
	glossaryUpdateRequestSchema,
	healthResponseSchema,
	sessionStartRequestSchema,
	sessionStopRequestSchema,
} from "~/lib/contract";
import { mintIngestToken } from "~/lib/contract/token.server";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { demoSessions } from "~/server/db/demo-sessions";
import { glossaryTerms, sessionEvents, sessions } from "~/server/db/schema";
import { subscribe } from "~/server/events/bus";
import { latestStats } from "~/server/events/state";

const uuid = z.string().uuid();
const language = z.string().regex(/^[a-z]{2,8}$/);
const slug = z
	.string()
	.regex(
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
		"Lowercase letters, digits and hyphens only",
	);

/**
 * `sourceConfig` shape per `sourceType`, mirroring the documented configs in
 * docs/components/ingest.md. The contract schema itself stays permissive for
 * `stream_url`/`device` while their producers are backlog; the admin form is
 * where the canonical fields are enforced.
 */
const sourceConfigSchemas = {
	browser_mic: z.object({}).strict(),
	file_replay: z
		.object({ path: z.string().min(1), loop: z.boolean() })
		.strict(),
	stream_url: z.object({ url: z.string().min(1) }).strict(),
	device: z
		.object({
			device: z.string().min(1),
			backend: z.enum(deviceBackends),
		})
		.strict(),
} satisfies Record<(typeof sourceTypes)[number], z.ZodTypeAny>;

const sessionInputObject = z.object({
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

/**
 * Rejects a `sourceConfig` that does not match its `sourceType`. On a partial
 * update `sourceType` may be absent (the existing pairing is kept); when it is
 * present, `sourceConfig` must come along so the stored pair stays coherent.
 */
function checkSourceConfig(
	value: { sourceType?: string; sourceConfig?: Record<string, unknown> },
	ctx: z.RefinementCtx,
) {
	if (!value.sourceType) return;
	if (!value.sourceConfig) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["sourceConfig"],
			message: "sourceConfig is required when sourceType is set",
		});
		return;
	}
	const schema =
		sourceConfigSchemas[value.sourceType as keyof typeof sourceConfigSchemas];
	const parsed = schema?.safeParse(value.sourceConfig);
	if (parsed && !parsed.success) {
		for (const issue of parsed.error.issues) {
			ctx.addIssue({ ...issue, path: ["sourceConfig", ...issue.path] });
		}
	}
}

const sessionInputSchema = sessionInputObject.superRefine(checkSourceConfig);

type Session = typeof sessions.$inferSelect;

/**
 * Effective glossary for a session: its own terms followed by the global
 * ones, deduplicated and capped per docs/components/glossary.md. Exported for
 * the session page's read-only preview.
 */
export async function mergedGlossary(sessionId: string) {
	const rows = await db
		.select({
			sessionId: glossaryTerms.sessionId,
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
		.orderBy(asc(glossaryTerms.createdAt), asc(glossaryTerms.id));
	return mergeGlossary(
		rows.filter((row) => row.sessionId === sessionId),
		rows.filter((row) => row.sessionId === null),
	);
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

async function callPipeline(
	method: "POST" | "PUT",
	path: string,
	body: unknown,
): Promise<{ ok: boolean; status: number; detail: string }> {
	const response = await fetch(`${env.PIPELINE_URL}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${env.SHARED_SECRET}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const detail = await response.text().catch(() => "");
	return { ok: response.ok, status: response.status, detail };
}

const postPipeline = (path: string, body: unknown) =>
	callPipeline("POST", path, body);
const putPipeline = (path: string, body: unknown) =>
	callPipeline("PUT", path, body);

/** Statuses whose active run can accept a glossary replacement. */
const liveStatuses: (typeof sessions.$inferSelect.status)[] = [
	"starting",
	"running",
];

/**
 * Pushes the merged glossary to the pipeline so later chunks of the active
 * run use it (`PUT /v1/sessions/{id}/glossary`, contract section 2). Best
 * effort: the endpoint may be missing (M4-02) or the run may have ended; the
 * stored terms still apply on the next start. Returns whether a push was
 * needed and succeeded: "ok" | "failed" | "skipped".
 */
async function syncRunningGlossary(
	sessionId: string,
): Promise<"ok" | "failed" | "skipped"> {
	const [session] = await db
		.select({ status: sessions.status })
		.from(sessions)
		.where(eq(sessions.id, sessionId));
	if (!session || !liveStatuses.includes(session.status)) return "skipped";
	try {
		const result = await putPipeline(
			`/v1/sessions/${sessionId}/glossary`,
			glossaryUpdateRequestSchema.parse({
				glossary: await mergedGlossary(sessionId),
			}),
		);
		return result.ok ? "ok" : "failed";
	} catch {
		return "failed";
	}
}

/**
 * Live-syncs the glossary after a mutation: a session-scoped change pushes to
 * that session; a global change pushes to every session with an active run.
 */
async function syncAfterGlossaryMutation(
	sessionId: string | null,
): Promise<"ok" | "failed" | "skipped"> {
	if (sessionId) return syncRunningGlossary(sessionId);
	const running = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(inArray(sessions.status, liveStatuses));
	let failed = false;
	for (const row of running) {
		if ((await syncRunningGlossary(row.id)) !== "ok") failed = true;
	}
	return running.length === 0 ? "skipped" : failed ? "failed" : "ok";
}

async function assertSessionExists(sessionId: string) {
	const [session] = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(eq(sessions.id, sessionId));
	if (!session) {
		throw new TRPCError({ code: "NOT_FOUND" });
	}
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

		/** Idempotent: seeds the demo sessions, skipping slugs that exist. */
		createDemo: protectedProcedure.mutation(() =>
			db
				.insert(sessions)
				.values([...demoSessions])
				.onConflictDoNothing({ target: sessions.slug })
				.returning(),
		),

		update: protectedProcedure
			.input(
				z.object({
					id: uuid,
					patch: sessionInputObject.partial().superRefine(checkSourceConfig),
				}),
			)
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

	glossary: createTRPCRouter({
		/** Terms of one scope: `sessionId` set -> that session's, else global. */
		list: protectedProcedure
			.input(z.object({ sessionId: uuid.nullish() }))
			.query(({ input }) =>
				db
					.select()
					.from(glossaryTerms)
					.where(
						input.sessionId
							? eq(glossaryTerms.sessionId, input.sessionId)
							: isNull(glossaryTerms.sessionId),
					)
					.orderBy(asc(glossaryTerms.createdAt), asc(glossaryTerms.id)),
			),

		/**
		 * Creates or updates a term. Without `id`, a same-scope term matching
		 * case-insensitively is updated instead of duplicated.
		 */
		upsert: protectedProcedure
			.input(
				z.object({
					id: uuid.optional(),
					sessionId: uuid.nullish(),
					term: z.string().trim().min(1),
					translation: z.string().trim().nullish(),
					notes: z.string().trim().nullish(),
				}),
			)
			.mutation(async ({ input }) => {
				const sessionId = input.sessionId ?? null;
				if (sessionId) await assertSessionExists(sessionId);
				const patch = {
					term: input.term,
					translation: input.translation || null,
					notes: input.notes || null,
				};

				let targetId = input.id;
				if (!targetId) {
					const existing = await db
						.select({ id: glossaryTerms.id, term: glossaryTerms.term })
						.from(glossaryTerms)
						.where(
							sessionId
								? eq(glossaryTerms.sessionId, sessionId)
								: isNull(glossaryTerms.sessionId),
						);
					targetId = existing.find(
						(row) => row.term.trim().toLowerCase() === patch.term.toLowerCase(),
					)?.id;
				}

				let row: typeof glossaryTerms.$inferSelect | undefined;
				if (targetId) {
					[row] = await db
						.update(glossaryTerms)
						.set(patch)
						.where(eq(glossaryTerms.id, targetId))
						.returning();
					if (!row) throw new TRPCError({ code: "NOT_FOUND" });
				} else {
					[row] = await db
						.insert(glossaryTerms)
						.values({ ...patch, sessionId })
						.returning();
				}
				return {
					term: row,
					liveSync: await syncAfterGlossaryMutation(sessionId),
				};
			}),

		/**
		 * Bulk paste (`term = translation`, one per line). Terms already present
		 * in the scope are skipped, not updated.
		 */
		addMany: protectedProcedure
			.input(z.object({ sessionId: uuid.nullish(), text: z.string().min(1) }))
			.mutation(async ({ input }) => {
				const sessionId = input.sessionId ?? null;
				if (sessionId) await assertSessionExists(sessionId);
				const parsed = parseBulkPaste(input.text);
				const existing = new Set(
					(
						await db
							.select({ term: glossaryTerms.term })
							.from(glossaryTerms)
							.where(
								sessionId
									? eq(glossaryTerms.sessionId, sessionId)
									: isNull(glossaryTerms.sessionId),
							)
					).map((row) => row.term.trim().toLowerCase()),
				);
				const fresh = parsed.filter(
					(item) => !existing.has(item.term.toLowerCase()),
				);
				const rows = fresh.length
					? await db
							.insert(glossaryTerms)
							.values(fresh.map((item) => ({ ...item, sessionId })))
							.returning()
					: [];
				return {
					added: rows.length,
					skipped: parsed.length - rows.length,
					liveSync: await syncAfterGlossaryMutation(sessionId),
				};
			}),

		delete: protectedProcedure
			.input(z.object({ id: uuid }))
			.mutation(async ({ input }) => {
				const [row] = await db
					.delete(glossaryTerms)
					.where(eq(glossaryTerms.id, input.id))
					.returning();
				if (!row) {
					throw new TRPCError({ code: "NOT_FOUND" });
				}
				return {
					deleted: true,
					liveSync: await syncAfterGlossaryMutation(row.sessionId),
				};
			}),
	}),

	events: createTRPCRouter({
		recent: protectedProcedure
			.input(
				z.object({
					sessionId: uuid,
					limit: z.number().int().positive().max(200).default(100),
				}),
			)
			.query(async ({ input }) => {
				const [session] = await db
					.select({ id: sessions.id })
					.from(sessions)
					.where(eq(sessions.id, input.sessionId));
				if (!session) {
					throw new TRPCError({ code: "NOT_FOUND" });
				}
				return db
					.select()
					.from(sessionEvents)
					.where(eq(sessionEvents.sessionId, input.sessionId))
					.orderBy(desc(sessionEvents.createdAt), desc(sessionEvents.id))
					.limit(input.limit);
			}),
	}),

	/**
	 * Proxies `GET /healthz` (contract section 2, no auth). Returns
	 * `{ ok: false }` instead of throwing so the dashboard can poll it and
	 * render an unreachable state rather than an error boundary.
	 */
	pipelineHealth: protectedProcedure.query(async () => {
		let parsed: ReturnType<typeof healthResponseSchema.safeParse>;
		try {
			const response = await fetch(`${env.PIPELINE_URL}/healthz`, {
				signal: AbortSignal.timeout(3_000),
			});
			parsed = healthResponseSchema.safeParse(await response.json());
		} catch (error) {
			return {
				ok: false as const,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		if (!parsed.success) {
			return { ok: false as const, error: "invalid healthz response" };
		}
		return { ok: true as const, health: parsed.data };
	}),

	/**
	 * Streams `status` and `log` events for all sessions (including the
	 * watchdog's `status_timeout` syntheses) over the `status:*` bus topic.
	 * No `lastEventId` catch-up: status truth lives in `sessions`, so the
	 * dashboard reconciles through `sessions.list` after a reconnect.
	 */
	onStatus: protectedProcedure.subscription(async function* ({ signal }) {
		type Item = Event | { type: "ping" };
		const queue: Item[] = [];
		let wake: (() => void) | undefined;
		const push = (item: Item) => {
			queue.push(item);
			wake?.();
		};

		const iterator = subscribe("status:*")[Symbol.asyncIterator]();
		const pump = (async () => {
			for (;;) {
				const { done, value } = await iterator.next();
				if (done) return;
				push(value);
			}
		})();
		const timer = setInterval(() => push({ type: "ping" }), 15_000);
		timer.unref?.();

		let seq = 0;
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
				} else {
					seq += 1;
					yield tracked(
						`${item.sessionId}:${item.runId}:${item.emittedAt}:${seq}`,
						item,
					);
				}
			}
		} finally {
			clearInterval(timer);
			await iterator.return?.();
			await pump;
		}
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
