CREATE TYPE "public"."event_level" AS ENUM('info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."segment_kind" AS ENUM('original', 'translation');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('idle', 'starting', 'running', 'stopping', 'error');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('browser_mic', 'file_replay', 'stream_url', 'device');--> statement-breakpoint
CREATE TYPE "public"."translation_mode" AS ENUM('ast', 'asr_then_text');--> statement-breakpoint
CREATE TABLE "glossary_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"term" text NOT NULL,
	"translation" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"kind" "segment_kind" NOT NULL,
	"language" text NOT NULL,
	"text" text NOT NULL,
	"is_final" boolean DEFAULT true NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"emitted_at" timestamp with time zone NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid,
	"level" "event_level" NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"room" text DEFAULT '' NOT NULL,
	"room_color" text DEFAULT 'violet' NOT NULL,
	"source_language" text NOT NULL,
	"target_languages" text[] NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"translation_mode" "translation_mode" DEFAULT 'ast' NOT NULL,
	"status" "session_status" DEFAULT 'idle' NOT NULL,
	"current_run_id" uuid,
	"last_error" text,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "glossary_terms" ADD CONSTRAINT "glossary_terms_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "glossary_terms_session" ON "glossary_terms" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "segments_chunk_lang" ON "segments" USING btree ("session_id","run_id","chunk_index","language");--> statement-breakpoint
CREATE INDEX "segments_session_run_start" ON "segments" USING btree ("session_id","run_id","start_ms");--> statement-breakpoint
CREATE INDEX "session_events_session_created" ON "session_events" USING btree ("session_id","created_at");