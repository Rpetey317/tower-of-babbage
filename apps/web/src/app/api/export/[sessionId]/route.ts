import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "~/server/db";
import { segments, sessions } from "~/server/db/schema";
import { type ExportFormat, renderExport } from "~/server/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.string().uuid();

const querySchema = z.object({
	format: z.enum(["srt", "vtt", "txt"]).default("srt"),
	lang: z
		.string()
		.regex(/^[a-z]{2,8}$/)
		.optional(),
	run: uuid.optional(),
});

const contentTypes: Record<ExportFormat, string> = {
	srt: "application/x-subrip",
	vtt: "text/vtt",
	txt: "text/plain; charset=utf-8",
};

/**
 * Full transcript download per docs/components/export.md. Public by design:
 * the audience is meant to share transcripts. `run` defaults to the current
 * run, `lang` to the first target language.
 */
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await params;
	const searchParams = new URL(request.url).searchParams;
	const parsedQuery = querySchema.safeParse(Object.fromEntries(searchParams));
	if (!parsedQuery.success || !uuid.safeParse(sessionId).success) {
		return NextResponse.json({ error: "invalid_params" }, { status: 400 });
	}
	const { format, run } = parsedQuery.data;
	const timestamps = searchParams.get("timestamps") === "1";

	const [session] = await db
		.select()
		.from(sessions)
		.where(eq(sessions.id, sessionId));
	if (!session) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}

	const lang =
		parsedQuery.data.lang ??
		session.targetLanguages[0] ??
		session.sourceLanguage;
	const runId = run ?? session.currentRunId;
	const rows = runId
		? await db
				.select({
					startMs: segments.startMs,
					endMs: segments.endMs,
					text: segments.text,
				})
				.from(segments)
				.where(
					and(
						eq(segments.sessionId, session.id),
						eq(segments.runId, runId),
						eq(segments.language, lang),
					),
				)
				.orderBy(asc(segments.chunkIndex))
		: [];

	return new Response(renderExport(format, rows, { timestamps }), {
		headers: {
			"Content-Type": contentTypes[format],
			"Content-Disposition": `attachment; filename="${session.slug}-${lang}.${format}"`,
		},
	});
}
