import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

const isProduction = process.env.NODE_ENV === "production";
const exampleSecret = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=";

const base64Secret = z
	.string()
	.refine(
		(value) =>
			/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				value,
			) && Buffer.from(value, "base64").length >= 32,
		"Must be a base64-encoded secret of at least 32 bytes",
	);

const httpUrl = z
	.string()
	.url()
	.refine(
		(value) => ["http:", "https:"].includes(new URL(value).protocol),
		"Must be an HTTP or HTTPS URL",
	);

export const env = createEnv({
	server: {
		DATABASE_URL: z.string().url(),
		DATABASE_URL_TEST: z.string().url().optional(),
		ADMIN_PASSWORD: z
			.string()
			.min(isProduction ? 12 : 1)
			.refine(
				(value) => !isProduction || value !== "change-me",
				"Replace the example ADMIN_PASSWORD in production",
			),
		AUTH_SECRET: base64Secret.refine(
			(value) => !isProduction || value !== exampleSecret,
			"Replace the example AUTH_SECRET in production",
		),
		SHARED_SECRET: base64Secret.refine(
			(value) => !isProduction || value !== exampleSecret,
			"Replace the example SHARED_SECRET in production",
		),
		PIPELINE_URL: httpUrl,
		// Directory `/api/media/[slug]` streams `file_replay` video sources
		// from; the same tree the pipeline sees as FIXTURES_DIR.
		MEDIA_DIR: z.string().default("../../fixtures/audio"),
		NODE_ENV: z
			.enum(["development", "test", "production"])
			.default("development"),
	},
	client: {
		NEXT_PUBLIC_PIPELINE_WS_URL: z
			.string()
			.url()
			.refine(
				(value) => ["ws:", "wss:"].includes(new URL(value).protocol),
				"Must be a WebSocket URL",
			),
		NEXT_PUBLIC_DEFAULT_LOCALE: z.enum(["es", "en"]).default("es"),
	},
	runtimeEnv: {
		DATABASE_URL: process.env.DATABASE_URL,
		DATABASE_URL_TEST: process.env.DATABASE_URL_TEST,
		ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
		AUTH_SECRET: process.env.AUTH_SECRET,
		SHARED_SECRET: process.env.SHARED_SECRET,
		PIPELINE_URL: process.env.PIPELINE_URL,
		MEDIA_DIR: process.env.MEDIA_DIR,
		NODE_ENV: process.env.NODE_ENV,
		NEXT_PUBLIC_PIPELINE_WS_URL: process.env.NEXT_PUBLIC_PIPELINE_WS_URL,
		NEXT_PUBLIC_DEFAULT_LOCALE: process.env.NEXT_PUBLIC_DEFAULT_LOCALE,
	},
	emptyStringAsUndefined: true,
});
