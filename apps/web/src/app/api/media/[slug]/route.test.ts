import { beforeEach, describe, expect, it } from "vitest";

import { db } from "~/server/db";
import { sessionEvents, sessions } from "~/server/db/schema";

import { GET } from "./route";

const sessionId = "6d953063-05b4-4cac-9249-58c8b1b326a1";

function get(slug: string, headers: Record<string, string> = {}) {
	return GET(new Request(`http://localhost/api/media/${slug}`, { headers }), {
		params: Promise.resolve({ slug }),
	});
}

function insertSession(
	slug: string,
	sourceType: "file_replay" | "browser_mic",
	sourceConfig: Record<string, unknown>,
) {
	return db.insert(sessions).values({
		id: sessionId,
		slug,
		title: "Media test session",
		sourceLanguage: "en",
		targetLanguages: ["es"],
		sourceType,
		sourceConfig,
	});
}

beforeEach(async () => {
	await db.delete(sessionEvents);
	await db.delete(sessions);
});

describe("GET /api/media/[slug]", () => {
	it("streams the video fixture with byte-range support", async () => {
		await insertSession("video-test", "file_replay", {
			path: "en-kubernetes-60s.mp4",
			loop: false,
		});

		const full = await get("video-test");
		expect(full.status).toBe(200);
		expect(full.headers.get("Content-Type")).toBe("video/mp4");
		expect(full.headers.get("Accept-Ranges")).toBe("bytes");
		const size = Number(full.headers.get("Content-Length"));
		expect(size).toBeGreaterThan(100_000);

		const partial = await get("video-test", { Range: "bytes=0-99" });
		expect(partial.status).toBe(206);
		expect(partial.headers.get("Content-Range")).toBe(`bytes 0-99/${size}`);
		expect(partial.headers.get("Content-Length")).toBe("100");
		const body = await partial.arrayBuffer();
		expect(body.byteLength).toBe(100);
	});

	it("answers 416 for an unsatisfiable range", async () => {
		await insertSession("video-test", "file_replay", {
			path: "en-kubernetes-60s.mp4",
			loop: false,
		});
		const response = await get("video-test", { Range: "bytes=99999999999-" });
		expect(response.status).toBe(416);
	});

	it("answers 404 for an unknown slug", async () => {
		expect((await get("missing")).status).toBe(404);
	});

	it("answers 404 for sessions without a playable video source", async () => {
		await insertSession("wav-test", "file_replay", {
			path: "en-kubernetes-60s.wav",
			loop: false,
		});
		expect((await get("wav-test")).status).toBe(404);

		await db.delete(sessions);
		await insertSession("mic-test", "browser_mic", {});
		expect((await get("mic-test")).status).toBe(404);
	});

	it("answers 404 for a path that escapes MEDIA_DIR", async () => {
		await insertSession("traversal", "file_replay", {
			path: "../../../etc/hostname.mp4",
			loop: false,
		});
		expect((await get("traversal")).status).toBe(404);
	});
});
