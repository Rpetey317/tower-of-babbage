import { readFileSync } from "node:fs";

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "~/env";
import { signAdminCookie } from "~/lib/auth/admin-cookie";
import { verifyIngestToken } from "~/lib/contract/token.server";
import { createCaller } from "~/server/api/root";
import { db } from "~/server/db";
import { glossaryTerms, sessions } from "~/server/db/schema";

const startFixture = JSON.parse(
	readFileSync(
		new URL(
			"../../../../../../packages/contract/fixtures/session-start.request.json",
			import.meta.url,
		),
		"utf8",
	),
) as Record<string, unknown>;

const sessionId = "1d953063-05b4-4cac-9249-58c8b1b326a1";

async function adminCaller() {
	const cookie = await signAdminCookie(env.AUTH_SECRET);
	return createCaller({
		db,
		headers: new Headers({ cookie: `tob_admin=${cookie}` }),
	});
}

function anonymousCaller() {
	return createCaller({ db, headers: new Headers() });
}

async function insertFixtureSession(
	overrides: Partial<typeof sessions.$inferInsert> = {},
) {
	await db.insert(sessions).values({
		id: sessionId,
		slug: "gran-sala",
		title: "Gran Sala",
		sourceLanguage: "en",
		targetLanguages: ["es"],
		sourceType: "browser_mic",
		sourceConfig: {},
		translationMode: "ast",
		...overrides,
	});
}

async function fixtureSession() {
	const [session] = await db
		.select()
		.from(sessions)
		.where(eq(sessions.id, sessionId));
	return session;
}

interface FetchCall {
	url: string;
	method: string;
	authorization: string | null;
	body: Record<string, unknown>;
}

function stubPipeline(
	status = 202,
	body: unknown = { runId: "", status: "starting" },
) {
	const calls: FetchCall[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: String(url),
				method: init?.method ?? "GET",
				authorization: new Headers(init?.headers).get("authorization"),
				body:
					typeof init?.body === "string"
						? (JSON.parse(init.body) as Record<string, unknown>)
						: {},
			});
			return new Response(JSON.stringify(body), { status });
		}),
	);
	return calls;
}

beforeEach(async () => {
	await db.delete(glossaryTerms);
	await db.delete(sessions);
	await insertFixtureSession();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("admin procedures auth", () => {
	it("rejects calls without a valid cookie", async () => {
		await expect(anonymousCaller().admin.sessions.list()).rejects.toMatchObject(
			{ code: "UNAUTHORIZED" },
		);
	});

	it("rejects calls with a forged cookie", async () => {
		const caller = createCaller({
			db,
			headers: new Headers({ cookie: "tob_admin=forged" }),
		});
		await expect(caller.admin.sessions.list()).rejects.toBeInstanceOf(
			TRPCError,
		);
	});
});

describe("admin.sessions", () => {
	it("creates, reads, updates and deletes a session", async () => {
		const caller = await adminCaller();

		const created = await caller.admin.sessions.create({
			title: "Nueva sala",
			slug: "nueva-sala",
			sourceLanguage: "es",
			targetLanguages: ["en", "pt"],
			sourceType: "file_replay",
			sourceConfig: { path: "es-charla-60s.wav", loop: true },
		});
		if (!created) throw new Error("create returned no session");
		expect(created.slug).toBe("nueva-sala");

		const fetched = await caller.admin.sessions.byId({ id: created.id });
		expect(fetched.slug).toBe("nueva-sala");
		expect(fetched.targetLanguages).toEqual(["en", "pt"]);

		const updated = await caller.admin.sessions.update({
			id: created.id,
			patch: { title: "Sala renombrada" },
		});
		expect(updated?.title).toBe("Sala renombrada");

		await caller.admin.sessions.delete({ id: created.id });
		await expect(
			caller.admin.sessions.byId({ id: created.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("refuses to delete a running session", async () => {
		await db
			.update(sessions)
			.set({ status: "running" })
			.where(eq(sessions.id, sessionId));

		const caller = await adminCaller();
		await expect(
			caller.admin.sessions.delete({ id: sessionId }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await fixtureSession()).toBeTruthy();
	});

	it("lists sessions", async () => {
		const caller = await adminCaller();
		const list = await caller.admin.sessions.list();
		expect(list.map((row) => row.slug)).toContain("gran-sala");
	});
});

describe("admin.sessions.start", () => {
	it("sends the contract start request and marks the session starting", async () => {
		await db.insert(glossaryTerms).values([
			{ sessionId, term: "Kubernetes", translation: null },
			{ sessionId: null, term: "pull request", translation: "pull request" },
		]);
		const calls = stubPipeline(202, {
			runId: "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77",
			status: "starting",
		});

		const caller = await adminCaller();
		const result = await caller.admin.sessions.start({ id: sessionId });
		expect(result.status).toBe("starting");

		const session = await fixtureSession();
		expect(session?.status).toBe("starting");
		expect(session?.currentRunId).toBe(result.runId);
		expect(session?.startedAt).toBeTruthy();

		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (!call) throw new Error("pipeline was not called");
		expect(call.url).toBe(`${env.PIPELINE_URL}/v1/sessions/${sessionId}/start`);
		expect(call.method).toBe("POST");
		expect(call.authorization).toBe(`Bearer ${env.SHARED_SECRET}`);
		expect({ ...call.body, runId: startFixture.runId }).toEqual(startFixture);
	});

	it("is idempotent on an already running session", async () => {
		const runId = "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";
		await db
			.update(sessions)
			.set({ status: "running", currentRunId: runId })
			.where(eq(sessions.id, sessionId));
		const calls = stubPipeline();

		const caller = await adminCaller();
		const result = await caller.admin.sessions.start({ id: sessionId });
		expect(result).toEqual({ runId, status: "running" });
		expect(calls).toHaveLength(0);
	});

	it("marks the session error when the pipeline rejects the start", async () => {
		const calls = stubPipeline(400, { error: "unsupported_language" });

		const caller = await adminCaller();
		const result = await caller.admin.sessions.start({ id: sessionId });
		expect(result.status).toBe("error");

		const session = await fixtureSession();
		expect(session?.status).toBe("error");
		expect(session?.lastError).toContain("pipeline 400");
		expect(calls).toHaveLength(1);
	});
});

describe("admin.sessions.stop", () => {
	it("sets stopping and posts the runId to the control API", async () => {
		const runId = "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";
		await db
			.update(sessions)
			.set({ status: "running", currentRunId: runId })
			.where(eq(sessions.id, sessionId));
		const calls = stubPipeline(202, { runId, status: "stopping" });

		const caller = await adminCaller();
		const result = await caller.admin.sessions.stop({ id: sessionId });
		expect(result.status).toBe("stopping");

		const session = await fixtureSession();
		expect(session?.status).toBe("stopping");

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			`${env.PIPELINE_URL}/v1/sessions/${sessionId}/stop`,
		);
		expect(calls[0]?.body).toEqual({ runId });
	});

	it("does nothing when the session is idle", async () => {
		const calls = stubPipeline();
		const caller = await adminCaller();
		const result = await caller.admin.sessions.stop({ id: sessionId });
		expect(result.status).toBe("idle");
		expect(calls).toHaveLength(0);
	});
});

describe("admin.ingestToken", () => {
	it("mints a token the pipeline verification accepts", async () => {
		const caller = await adminCaller();
		const { token } = await caller.admin.ingestToken({ sessionId });
		expect(verifyIngestToken(token, sessionId, env.SHARED_SECRET)).toBe(true);
	});
});
