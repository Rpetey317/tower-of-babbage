import {
	bigserial,
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

export const sourceTypeEnum = pgEnum("source_type", [
	"browser_mic",
	"file_replay",
	"stream_url",
	"device",
]);

export const translationModeEnum = pgEnum("translation_mode", [
	"ast",
	"asr_then_text",
]);

export const sessionStatusEnum = pgEnum("session_status", [
	"idle",
	"starting",
	"running",
	"stopping",
	"error",
]);

export const segmentKindEnum = pgEnum("segment_kind", [
	"original",
	"translation",
]);

export const eventLevelEnum = pgEnum("event_level", ["info", "warn", "error"]);

export const sessions = pgTable("sessions", {
	id: uuid().primaryKey().defaultRandom(),
	slug: text().notNull().unique(),
	title: text().notNull(),
	room: text().notNull().default(""),
	roomColor: text("room_color").notNull().default("violet"),
	sourceLanguage: text("source_language").notNull(),
	targetLanguages: text("target_languages").array().notNull(),
	sourceType: sourceTypeEnum("source_type").notNull(),
	sourceConfig: jsonb("source_config").notNull().default({}),
	translationMode: translationModeEnum("translation_mode")
		.notNull()
		.default("ast"),
	status: sessionStatusEnum().notNull().default("idle"),
	currentRunId: uuid("current_run_id"),
	lastError: text("last_error"),
	startedAt: timestamp("started_at", { withTimezone: true }),
	stoppedAt: timestamp("stopped_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const segments = pgTable(
	"segments",
	{
		id: uuid().primaryKey().defaultRandom(),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		runId: uuid("run_id").notNull(),
		chunkIndex: integer("chunk_index").notNull(),
		kind: segmentKindEnum().notNull(),
		language: text().notNull(),
		text: text().notNull(),
		isFinal: boolean("is_final").notNull().default(true),
		startMs: integer("start_ms").notNull(),
		endMs: integer("end_ms").notNull(),
		emittedAt: timestamp("emitted_at", { withTimezone: true }).notNull(),
		latencyMs: integer("latency_ms").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		uniqueIndex("segments_chunk_lang").on(
			t.sessionId,
			t.runId,
			t.chunkIndex,
			t.language,
		),
		index("segments_session_run_start").on(t.sessionId, t.runId, t.startMs),
	],
);

export const glossaryTerms = pgTable(
	"glossary_terms",
	{
		id: uuid().primaryKey().defaultRandom(),
		sessionId: uuid("session_id").references(() => sessions.id, {
			onDelete: "cascade",
		}),
		term: text().notNull(),
		translation: text(),
		notes: text(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("glossary_terms_session").on(t.sessionId)],
);

export const sessionEvents = pgTable(
	"session_events",
	{
		id: bigserial({ mode: "number" }).primaryKey(),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		runId: uuid("run_id"),
		level: eventLevelEnum().notNull(),
		code: text().notNull(),
		message: text().notNull(),
		data: jsonb(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("session_events_session_created").on(t.sessionId, t.createdAt)],
);
