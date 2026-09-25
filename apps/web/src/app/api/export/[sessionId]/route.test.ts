import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "~/server/db";
import { segments, sessionEvents, sessions } from "~/server/db/schema";

import { GET } from "./route";

const sessionId = "4d953063-05b4-4cac-9249-58c8b1b326a1";
const runId = "6c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";

function get(id: string, query = "") {
	return GET(new Request(`http://localhost/api/export/${id}${query}`), {
		params: Promise.resolve({ sessionId: id }),
	});
}

function insertSegment(
	chunkIndex: number,
	language: string,
	text: string,
	startMs: number,
	endMs: number,
) {
	return db.insert(segments).values({
		sessionId,
		runId,
		chunkIndex,
		kind: language === "en" ? "original" : "translation",
		language,
		text,
		startMs,
		endMs,
		emittedAt: new Date(),
		latencyMs: 100,
	});
}

beforeEach(async () => {
	await db.delete(segments);
	await db.delete(sessionEvents);
	await db.delete(sessions);
	await db.insert(sessions).values({
		id: sessionId,
		slug: "export-test",
		title: "Export test session",
		sourceLanguage: "en",
		targetLanguages: ["es"],
		sourceType: "file_replay",
		currentRunId: runId,
	});
	for (const [index, startMs] of [0, 3_000, 6_000].entries()) {
		await insertSegment(
			index,
			"en",
			`English chunk ${index}.`,
			startMs,
			startMs + 2_500,
		);
		await insertSegment(
			index,
			"es",
			`Fragmento en español ${index}.`,
			startMs,
			startMs + 2_500,
		);
	}
});

describe("GET /api/export/[sessionId]", () => {
	it("defaults to SRT of the first target language", async () => {
		const response = await get(sessionId);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/x-subrip");
		expect(response.headers.get("content-disposition")).toBe(
			'attachment; filename="export-test-es.srt"',
		);

		const body = await response.text();
		const cues = body.trim().split("\n\n");
		expect(cues).toHaveLength(3);
		expect(cues[0]).toMatch(
			/^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/,
		);
		expect(body).toContain("00:00:00,000 --> 00:00:02,500");
		expect(body).toContain("Fragmento en español 0.");
		expect(body).not.toContain("English chunk");
	});

	it("serves VTT for the source language when lang=en", async () => {
		const response = await get(sessionId, "?format=vtt&lang=en");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/vtt");
		expect(response.headers.get("content-disposition")).toBe(
			'attachment; filename="export-test-en.vtt"',
		);

		const body = await response.text();
		expect(body.startsWith("WEBVTT\n")).toBe(true);
		expect(body).toContain("00:00:03.000 --> 00:00:05.500");
		expect(body).toContain("English chunk 1.");
	});

	it("serves TXT with [HH:MM:SS] prefixes when timestamps=1", async () => {
		const response = await get(sessionId, "?format=txt&lang=es&timestamps=1");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"text/plain; charset=utf-8",
		);
		expect(response.headers.get("content-disposition")).toBe(
			'attachment; filename="export-test-es.txt"',
		);

		const body = await response.text();
		expect(body).toContain("[00:00:00] Fragmento en español 0.");
		expect(body).toContain("[00:00:06] Fragmento en español 2.");
	});

	it("restricts to an explicit run when run= is given", async () => {
		const otherRun = "7c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";
		const response = await get(sessionId, `?run=${otherRun}`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("");
	});

	it("rejects a bad format or malformed params with 400", async () => {
		for (const query of ["?format=bogus", "?lang=ESP", "?run=not-a-uuid"]) {
			const response = await get(sessionId, query);
			expect(response.status).toBe(400);
		}
	});

	it("returns 404 for an unknown or malformed session id", async () => {
		const missing = await get("9d953063-05b4-4cac-9249-58c8b1b326a1");
		expect(missing.status).toBe(404);
		const malformed = await get("not-a-uuid");
		expect(malformed.status).toBe(400);
	});

	it("answers an empty export when the session never ran", async () => {
		await db.delete(segments);
		await db
			.update(sessions)
			.set({ currentRunId: null })
			.where(eq(sessions.id, sessionId));

		const srt = await get(sessionId);
		expect(srt.status).toBe(200);
		expect(await srt.text()).toBe("");

		const vtt = await get(sessionId, "?format=vtt");
		expect(await vtt.text()).toBe("WEBVTT\n\n");
	});
});
