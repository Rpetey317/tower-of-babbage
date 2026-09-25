import { z } from "zod";

export const contractVersion = 2 as const;

const uuid = z
	.string()
	.uuid()
	.regex(/^[0-9a-f-]+$/);
const language = z.string().regex(/^[a-z]{2,8}$/);
const milliseconds = z.number().int().nonnegative();
const emittedAt = z.string().datetime({ precision: 3, offset: false });

export const sessionStatusSchema = z.enum([
	"idle",
	"starting",
	"running",
	"stopping",
	"error",
]);

export const statsSchema = z
	.object({
		audioReceivedMs: milliseconds,
		chunksProcessed: milliseconds,
		chunksDropped: milliseconds,
		queueDepth: milliseconds,
		latencyP50Ms: milliseconds,
		latencyP95Ms: milliseconds,
		lastError: z.string().nullable(),
	})
	.strict();

export const healthResponseSchema = z
	.object({
		status: z.literal("ok"),
		contractVersion: z.literal(contractVersion),
		provider: z.string(),
		endpoints: z.array(
			z.object({ url: z.string().url(), healthy: z.boolean() }).strict(),
		),
		activeSessions: milliseconds,
	})
	.strict();

export const sessionsResponseSchema = z
	.object({
		sessions: z.array(
			z
				.object({
					sessionId: uuid,
					runId: uuid,
					status: sessionStatusSchema,
					stats: statsSchema,
				})
				.strict(),
		),
	})
	.strict();

export const glossaryTermSchema = z
	.object({ term: z.string(), translation: z.string().nullable() })
	.strict();

export const sourceSchema = z.discriminatedUnion("type", [
	z
		.object({ type: z.literal("browser_mic"), config: z.object({}).strict() })
		.strict(),
	z
		.object({
			type: z.literal("file_replay"),
			config: z.object({ path: z.string(), loop: z.boolean() }).strict(),
		})
		.strict(),
	z
		.object({ type: z.literal("stream_url"), config: z.record(z.unknown()) })
		.strict(),
	z
		.object({ type: z.literal("device"), config: z.record(z.unknown()) })
		.strict(),
]);

export const sessionStartRequestSchema = z
	.object({
		contractVersion: z.literal(contractVersion),
		runId: uuid,
		slug: z.string(),
		sourceLanguage: language,
		targetLanguages: z.array(language),
		translationMode: z.enum(["ast", "asr_then_text"]),
		source: sourceSchema,
		glossary: z.array(glossaryTermSchema),
	})
	.strict();

export const sessionStartResponseSchema = z
	.object({ runId: uuid, status: z.literal("starting") })
	.strict();

export const sessionStopRequestSchema = z.object({ runId: uuid }).strict();
export const sessionStopResponseSchema = z
	.object({ runId: uuid, status: z.literal("stopping") })
	.strict();

export const glossaryUpdateRequestSchema = z
	.object({ glossary: z.array(glossaryTermSchema) })
	.strict();
export const glossaryUpdateResponseSchema = z
	.object({ count: milliseconds })
	.strict();

export const controlErrorSchema = z
	.object({
		error: z.enum([
			"unauthorized",
			"contract_version_mismatch",
			"already_running",
			"unsupported_language",
			"invalid_source",
			"not_running",
		]),
		runId: uuid.optional(),
	})
	.strict();

const eventBase = {
	sessionId: uuid,
	runId: uuid,
	emittedAt,
};

export const segmentEventSchema = z
	.object({
		...eventBase,
		type: z.literal("segment"),
		chunkIndex: milliseconds,
		kind: z.enum(["original", "translation"]),
		language,
		text: z.string(),
		// Optional per-chunk speaker label attributed by the provider (v2).
		speaker: z.string().min(1).optional(),
		isFinal: z.boolean(),
		startMs: milliseconds,
		endMs: milliseconds,
		latencyMs: milliseconds,
	})
	.strict();

export const statusEventSchema = z
	.object({
		...eventBase,
		type: z.literal("status"),
		status: sessionStatusSchema,
		stats: statsSchema,
	})
	.strict();

export const logEventSchema = z
	.object({
		...eventBase,
		type: z.literal("log"),
		level: z.enum(["info", "warn", "error"]),
		code: z.string(),
		message: z.string(),
		data: z.record(z.unknown()).nullable().optional(),
	})
	.strict();

export const eventSchema = z.discriminatedUnion("type", [
	segmentEventSchema,
	statusEventSchema,
	logEventSchema,
]);

export const eventBatchSchema = z
	.object({
		contractVersion: z.literal(contractVersion),
		events: z.array(eventSchema),
	})
	.strict();

export const eventBatchResponseSchema = z
	.object({ accepted: milliseconds })
	.strict();

export const eventBatchErrorSchema = z
	.object({ error: z.literal("invalid_events"), details: z.array(z.unknown()) })
	.strict();

export const ingestHelloSchema = z
	.object({
		type: z.literal("hello"),
		format: z.literal("pcm_s16le"),
		sampleRate: z.literal(16000),
		channels: z.literal(1),
	})
	.strict();

export const ingestReadySchema = z
	.object({ type: z.literal("ready"), sessionId: uuid, runId: uuid })
	.strict();

export const ingestStatsSchema = z
	.object({
		type: z.literal("stats"),
		audioReceivedMs: milliseconds,
		queueDepth: milliseconds,
	})
	.strict();

export const ingestEndSchema = z.object({ type: z.literal("end") }).strict();

export const ingestMessageSchema = z.discriminatedUnion("type", [
	ingestHelloSchema,
	ingestReadySchema,
	ingestStatsSchema,
	ingestEndSchema,
]);

export type Event = z.infer<typeof eventSchema>;
export type EventBatch = z.infer<typeof eventBatchSchema>;
export type SessionStartRequest = z.infer<typeof sessionStartRequestSchema>;
