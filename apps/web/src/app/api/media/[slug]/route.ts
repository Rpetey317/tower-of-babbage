import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { env } from "~/env";
import {
	parseRange,
	videoExtension,
	videoMediaPath,
	videoMime,
} from "~/lib/playback";
import { db } from "~/server/db";
import { sessions } from "~/server/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () =>
	NextResponse.json({ error: "not_found" }, { status: 404 });

/**
 * Resolves `relative` inside `dir`, refusing anything that escapes it.
 * `videoMediaPath` already rejected traversal; this is the belt-and-braces
 * check against the resolved path (e.g. a `..` hiding behind a symlinked
 * MEDIA_DIR entry is still a real-path concern only for the caller).
 */
function resolveUnder(dir: string, relative: string): string | null {
	const root = path.resolve(dir);
	const resolved = path.resolve(root, relative);
	return resolved.startsWith(root + path.sep) ? resolved : null;
}

/**
 * Streams the video fixture a `file_replay` session replays, for
 * `/s/[slug]/play` (docs/components/playback.md). Public like the rest of
 * the audience surface; only files referenced by a session's sourceConfig
 * are reachable. Supports single-byte `Range` requests so the `<video>`
 * element can seek.
 */
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ slug: string }> },
) {
	const { slug } = await params;
	const [session] = await db
		.select({
			sourceType: sessions.sourceType,
			sourceConfig: sessions.sourceConfig,
		})
		.from(sessions)
		.where(eq(sessions.slug, slug))
		.limit(1);
	const relative = session ? videoMediaPath(session) : null;
	if (!relative) return notFound();

	const file = resolveUnder(env.MEDIA_DIR, relative);
	if (!file) return notFound();
	const info = await stat(file).catch(() => null);
	if (!info?.isFile()) return notFound();

	const size = info.size;
	const range = parseRange(request.headers.get("range"), size);
	if (range === "invalid") {
		return new NextResponse(null, {
			status: 416,
			headers: { "Content-Range": `bytes */${size}` },
		});
	}

	const contentType = videoMime[videoExtension(relative) ?? ""] ?? null;
	if (contentType === null) return notFound();

	const headers: Record<string, string> = {
		"Accept-Ranges": "bytes",
		"Content-Type": contentType,
		"Cache-Control": "no-cache",
	};
	let status = 200;
	if (range) {
		status = 206;
		headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
		headers["Content-Length"] = String(range.end - range.start + 1);
	} else {
		headers["Content-Length"] = String(size);
	}

	const stream = createReadStream(file, range ?? undefined);
	return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
		status,
		headers,
	});
}
