import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { env } from "~/env";
import type { Event, EventBatch } from "~/lib/contract";
import { db } from "~/server/db";
import { segments, sessionEvents, sessions } from "~/server/db/schema";
import { subscribe } from "~/server/events/bus";
import { sweepStaleSessions } from "~/server/events/watchdog";

import { POST } from "./route";

const batch = JSON.parse(
	readFileSync(
		new URL(
			"../../../../../../../packages/contract/fixtures/events.batch.json",
			import.meta.url,
		),
		"utf8",
	),
) as EventBatch;

const sessionId = "1d953063-05b4-4cac-9249-58c8b1b326a1";
const runId = "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";

function post(body: unknown, secret = env.SHARED_SECRET) {
	return POST(
		new Request("http://localhost/api/internal/events", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${secret}`,
			},
			body: JSON.stringify(body),
		}),
	);
}

async function insertSession(
	overrides: Partial<typeof sessions.$inferInsert> = {},
) {
	await db.insert(sessions).values({
		id: sessionId,
		slug: `test-${sessionId.slice(0, 8)}`,
		title: "Route test session",
		sourceLanguage: "en",
		targetLanguages: ["es"],
		sourceType: "file_replay",
		...overrides,
	});
}

async function segmentRows() {
	return db.select().from(segments).where(eq(segments.sessionId, sessionId));
}

async function drain(iterator: AsyncIterator<Event>, count: number) {
	const received: Event[] = [];
	for (let i = 0; i < count; i++) {
		received.push((await iterator.next()).value as Event);
	}
	await iterator.return?.();
	return received;
}

beforeEach(async () => {
	await db.delete(segments);
	await db.delete(sessionEvents);
	await db.delete(sessions);
	await insertSession();
});

describe("POST /api/internal/events", () => {
	it("accepts a valid batch and persists every event", async () => {
		const onSegments = subscribe(`segments:${sessionId}`)[
			Symbol.asyncIterator
		]();
		const onStatus = subscribe(`status:${sessionId}`)[Symbol.asyncIterator]();
		const onAllStatus = subscribe("status:*")[Symbol.asyncIterator]();

		const response = await post(batch);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: 4 });

		const rows = await segmentRows();
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.language).sort()).toEqual(["en", "es"]);
		expect(rows.find((r) => r.language === "en")?.speaker).toBe("S1");
		expect(rows.find((r) => r.language === "es")?.speaker).toBe("S1");

		const [session] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId));
		expect(session).toMatchObject({
			status: "running",
			currentRunId: runId,
			lastError: null,
		});

		const logs = await db
			.select()
			.from(sessionEvents)
			.where(eq(sessionEvents.sessionId, sessionId));
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({ level: "warn", code: "chunk_dropped" });

		// Each of the 4 events reached the bus on its topic.
		expect(await drain(onSegments, 2)).toHaveLength(2);
		expect(await drain(onStatus, 1)).toHaveLength(1);
		expect(await drain(onAllStatus, 2)).toHaveLength(2);
	});

	it("rejects a missing or wrong bearer with 401", async () => {
		const response = await post(batch, "wrong-secret");
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
		expect(await segmentRows()).toHaveLength(0);
	});

	it("rejects a malformed event with 400 and writes nothing", async () => {
		const malformed = {
			contractVersion: 2,
			events: [
				batch.events[0],
				{ ...batch.events[1], text: undefined },
				batch.events[2],
			],
		};
		const response = await post(malformed);
		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_events");

		expect(await segmentRows()).toHaveLength(0);
		const [session] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId));
		expect(session?.status).toBe("idle");
	});

	it("rejects a contract version mismatch", async () => {
		const response = await post({ ...batch, contractVersion: 1 });
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "contract_version_mismatch",
		});
	});

	it("upserts a duplicate segment instead of writing a second row", async () => {
		await post(batch);

		const edited = {
			...batch,
			events: [{ ...batch.events[0], text: "Edited original text." }],
		};
		const response = await post(edited);
		expect(response.status).toBe(200);

		const rows = await segmentRows();
		const originals = rows.filter((r) => r.language === "en");
		expect(originals).toHaveLength(1);
		expect(originals[0]?.text).toBe("Edited original text.");
	});
});

describe("watchdog", () => {
	// Distinct ids so the in-memory last-status map from earlier tests does not
	// mark these sessions fresh.
	const staleSessionId = "2d953063-05b4-4cac-9249-58c8b1b326a1";
	const freshSessionId = "3d953063-05b4-4cac-9249-58c8b1b326a1";

	it("marks a session stale on status as error with status_timeout", async () => {
		await insertSession({ id: staleSessionId, slug: "stale-session" });
		const stale = new Date(Date.now() - 20_000);
		await db
			.update(sessions)
			.set({ status: "running", currentRunId: runId, updatedAt: stale })
			.where(eq(sessions.id, staleSessionId));

		const onAllStatus = subscribe("status:*")[Symbol.asyncIterator]();
		await sweepStaleSessions();

		const [session] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, staleSessionId));
		expect(session?.status).toBe("error");
		expect(session?.lastError).toBe("status_timeout");

		const logs = await db
			.select()
			.from(sessionEvents)
			.where(eq(sessionEvents.sessionId, staleSessionId));
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({ level: "error", code: "status_timeout" });

		const [published] = await drain(onAllStatus, 1);
		expect(published).toMatchObject({
			type: "status",
			sessionId: staleSessionId,
			status: "error",
		});
	});

	it("leaves a recently updated session alone", async () => {
		await insertSession({ id: freshSessionId, slug: "fresh-session" });
		await db
			.update(sessions)
			.set({ status: "running", currentRunId: runId, updatedAt: new Date() })
			.where(eq(sessions.id, freshSessionId));

		await sweepStaleSessions();

		const [session] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, freshSessionId));
		expect(session?.status).toBe("running");
	});
});
