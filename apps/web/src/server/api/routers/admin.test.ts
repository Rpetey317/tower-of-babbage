import { readFileSync } from "node:fs";

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "~/env";
import { signAdminCookie } from "~/lib/auth/admin-cookie";
import type { Event } from "~/lib/contract";
import { verifyIngestToken } from "~/lib/contract/token.server";
import { createCaller } from "~/server/api/root";
import { db } from "~/server/db";
import { glossaryTerms, sessionEvents, sessions } from "~/server/db/schema";
import { publish } from "~/server/events/bus";

const startFixture = JSON.parse(
	readFileSync(
		new URL(
			"../../../../../../packages/contract/fixtures/session-start.request.json",
			import.meta.url,
		),
		"utf8",
	),
) as Record<string, unknown>;

const healthzFixture = JSON.parse(
	readFileSync(
		new URL(
			"../../../../../../packages/contract/fixtures/healthz.response.json",
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
	await db.delete(sessionEvents);
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

	it.each([
		["browser_mic", {}],
		["file_replay", { path: "en-kubernetes-60s.wav", loop: true }],
		["stream_url", { url: "rtmp://example.test/live" }],
		["device", { device: "default", backend: "pulse" }],
	] as const)(
		"persists the documented sourceConfig for %s",
		async (sourceType, sourceConfig) => {
			const caller = await adminCaller();
			const created = await caller.admin.sessions.create({
				title: `Sala ${sourceType}`,
				slug: `sala-${sourceType.replace("_", "-")}`,
				sourceLanguage: "en",
				targetLanguages: ["es"],
				sourceType,
				sourceConfig,
			});
			if (!created) throw new Error("create returned no session");
			expect(created.sourceType).toBe(sourceType);
			expect(created.sourceConfig).toEqual(sourceConfig);
		},
	);

	it("rejects a sourceConfig that does not match the sourceType", async () => {
		const caller = await adminCaller();
		await expect(
			caller.admin.sessions.create({
				title: "Sala sin path",
				slug: "sala-sin-path",
				sourceLanguage: "en",
				targetLanguages: ["es"],
				sourceType: "file_replay",
				sourceConfig: {},
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		await expect(
			caller.admin.sessions.update({
				id: sessionId,
				patch: { sourceType: "device" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("creates and starts a pt -> es session (M6-01)", async () => {
		const caller = await adminCaller();
		const created = await caller.admin.sessions.create({
			title: "Palestra",
			slug: "palestra",
			sourceLanguage: "pt",
			targetLanguages: ["es"],
			sourceType: "browser_mic",
			sourceConfig: {},
		});
		if (!created) throw new Error("create returned no session");

		const calls = stubPipeline(202, { runId: "", status: "starting" });
		const result = await caller.admin.sessions.start({ id: created.id });
		expect(result.status).toBe("starting");
		expect(calls[0]?.body.sourceLanguage).toBe("pt");
		expect(calls[0]?.body.targetLanguages).toEqual(["es"]);
	});

	it("accepts unverified but supported languages", async () => {
		const caller = await adminCaller();
		const created = await caller.admin.sessions.create({
			title: "Salle",
			slug: "salle",
			sourceLanguage: "fr",
			targetLanguages: ["de", "it"],
			sourceType: "browser_mic",
			sourceConfig: {},
		});
		expect(created?.sourceLanguage).toBe("fr");
		expect(created?.targetLanguages).toEqual(["de", "it"]);
	});

	it("rejects languages outside SUPPORTED_LANGUAGES", async () => {
		const caller = await adminCaller();
		const base = {
			title: "Sala",
			slug: "sala-xx",
			sourceType: "browser_mic" as const,
			sourceConfig: {},
		};
		await expect(
			caller.admin.sessions.create({
				...base,
				sourceLanguage: "xx",
				targetLanguages: ["es"],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			caller.admin.sessions.create({
				...base,
				sourceLanguage: "en",
				targetLanguages: ["es", "en-US"],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			caller.admin.sessions.update({
				id: sessionId,
				patch: { targetLanguages: ["xx"] },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("seeds the demo sessions idempotently", async () => {
		const caller = await adminCaller();
		const created = await caller.admin.sessions.createDemo();
		expect(created.map((row) => row.slug).sort()).toEqual([
			"demo-en",
			"demo-es",
		]);

		const demo = created.find((row) => row.slug === "demo-en");
		expect(demo?.sourceType).toBe("file_replay");
		expect(demo?.sourceConfig).toEqual({
			path: "en-kubernetes-60s.wav",
			loop: false,
		});

		const again = await caller.admin.sessions.createDemo();
		expect(again).toHaveLength(0);
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

	it("dedupes glossary terms across scopes and caps at 40", async () => {
		await db.insert(glossaryTerms).values({
			sessionId,
			term: "Kubernetes",
			translation: "Kube",
		});
		await db.insert(glossaryTerms).values(
			[
				"kubernetes", // duplicate of the session term: must lose
				...Array.from({ length: 45 }, (_, i) => `g-${i}`),
			].map((term) => ({
				sessionId: null as string | null,
				term,
				translation: null,
			})),
		);
		const calls = stubPipeline(202, {
			runId: "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77",
			status: "starting",
		});

		const caller = await adminCaller();
		await caller.admin.sessions.start({ id: sessionId });

		const glossary = calls[0]?.body.glossary as {
			term: string;
			translation: string | null;
		}[];
		expect(glossary).toHaveLength(40);
		expect(glossary[0]).toEqual({ term: "Kubernetes", translation: "Kube" });
		expect(
			glossary.filter((item) => item.term.toLowerCase() === "kubernetes"),
		).toHaveLength(1);
	});
});

describe("admin.glossary", () => {
	it("lists terms per scope", async () => {
		await db.insert(glossaryTerms).values([
			{ sessionId, term: "Nerdearla" },
			{ sessionId: null, term: "kubectl" },
		]);

		const caller = await adminCaller();
		const scoped = await caller.admin.glossary.list({ sessionId });
		const global = await caller.admin.glossary.list({});
		expect(scoped.map((row) => row.term)).toEqual(["Nerdearla"]);
		expect(global.map((row) => row.term)).toEqual(["kubectl"]);
	});

	it("upserts by term within a scope instead of duplicating", async () => {
		const caller = await adminCaller();
		const first = await caller.admin.glossary.upsert({
			sessionId: null,
			term: "Kubernetes",
		});
		const again = await caller.admin.glossary.upsert({
			sessionId: null,
			term: "kubernetes",
			translation: "kube",
		});
		expect(again.term?.id).toBe(first.term?.id);

		const global = await caller.admin.glossary.list({});
		expect(global).toHaveLength(1);
		expect(global[0]?.translation).toBe("kube");

		const scoped = await caller.admin.glossary.upsert({
			sessionId,
			term: "KUBERNETES",
		});
		expect(scoped.term?.id).not.toBe(first.term?.id);
	});

	it("updates an existing term by id", async () => {
		const caller = await adminCaller();
		const created = await caller.admin.glossary.upsert({
			sessionId: null,
			term: "etcd",
		});
		const updated = await caller.admin.glossary.upsert({
			id: created.term?.id,
			term: "etcd",
			notes: "key-value store",
		});
		expect(updated.term?.notes).toBe("key-value store");
	});

	it("rejects a term for an unknown session", async () => {
		const caller = await adminCaller();
		await expect(
			caller.admin.glossary.upsert({
				sessionId: "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77",
				term: "etcd",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("bulk-imports pasted terms and skips existing ones", async () => {
		await db.insert(glossaryTerms).values({ sessionId, term: "kubectl" });

		const caller = await adminCaller();
		const result = await caller.admin.glossary.addMany({
			sessionId,
			text: "kubectl = kube ctl\nNerdearla\netcd\n",
		});
		expect(result.added).toBe(2);
		expect(result.skipped).toBe(1);

		const terms = await caller.admin.glossary.list({ sessionId });
		expect(terms).toHaveLength(3);
		expect(terms[0]?.term).toBe("kubectl");
		expect(terms.map((row) => row.term)).toEqual(
			expect.arrayContaining(["kubectl", "Nerdearla", "etcd"]),
		);
	});

	it("deletes a term", async () => {
		const caller = await adminCaller();
		const created = await caller.admin.glossary.upsert({
			sessionId: null,
			term: "etcd",
		});
		const id = created.term?.id;
		if (!id) throw new Error("upsert returned no term");

		await caller.admin.glossary.delete({ id });
		expect(await caller.admin.glossary.list({})).toHaveLength(0);
		await expect(caller.admin.glossary.delete({ id })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("pushes the merged glossary to the pipeline when the session is running", async () => {
		await db
			.update(sessions)
			.set({ status: "running" })
			.where(eq(sessions.id, sessionId));
		await db.insert(glossaryTerms).values([
			{ sessionId, term: "Nerdearla" },
			{ sessionId: null, term: "kubectl", translation: "kube ctl" },
		]);
		const calls = stubPipeline(200, { count: 3 });

		const caller = await adminCaller();
		const result = await caller.admin.glossary.upsert({
			sessionId,
			term: "etcd",
		});
		expect(result.liveSync).toBe("ok");

		const put = calls.find((call) => call.method === "PUT");
		expect(put?.url).toBe(
			`${env.PIPELINE_URL}/v1/sessions/${sessionId}/glossary`,
		);
		expect(put?.authorization).toBe(`Bearer ${env.SHARED_SECRET}`);
		expect(put?.body).toEqual({
			glossary: [
				{ term: "Nerdearla", translation: null },
				{ term: "etcd", translation: null },
				{ term: "kubectl", translation: "kube ctl" },
			],
		});
	});

	it("pushes a global change to every session with an active run", async () => {
		const otherId = "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";
		await db.insert(sessions).values({
			id: otherId,
			slug: "otra-sala",
			title: "Otra Sala",
			sourceLanguage: "en",
			targetLanguages: ["es"],
			sourceType: "browser_mic",
			sourceConfig: {},
			status: "running",
		});
		await db
			.update(sessions)
			.set({ status: "running" })
			.where(eq(sessions.id, sessionId));
		const calls = stubPipeline(200, { count: 1 });

		const caller = await adminCaller();
		const result = await caller.admin.glossary.addMany({
			sessionId: null,
			text: "etcd",
		});
		expect(result.liveSync).toBe("ok");

		const puts = calls.filter((call) => call.method === "PUT");
		expect(puts.map((call) => call.url).sort()).toEqual([
			`${env.PIPELINE_URL}/v1/sessions/${sessionId}/glossary`,
			`${env.PIPELINE_URL}/v1/sessions/${otherId}/glossary`,
		]);
	});

	it("skips the live push when nothing is running", async () => {
		const calls = stubPipeline(200, { count: 0 });
		const caller = await adminCaller();
		const result = await caller.admin.glossary.upsert({
			sessionId,
			term: "etcd",
		});
		expect(result.liveSync).toBe("skipped");
		expect(calls).toHaveLength(0);
	});

	it("tolerates the pipeline rejecting the live push", async () => {
		await db
			.update(sessions)
			.set({ status: "running" })
			.where(eq(sessions.id, sessionId));
		stubPipeline(404, { error: "not_running" });

		const caller = await adminCaller();
		const result = await caller.admin.glossary.upsert({
			sessionId,
			term: "etcd",
		});
		expect(result.liveSync).toBe("failed");
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

	it("releases a run still held by the pipeline on an error session", async () => {
		const runId = "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";
		await db
			.update(sessions)
			.set({
				status: "error",
				currentRunId: runId,
				lastError: "status_timeout",
			})
			.where(eq(sessions.id, sessionId));
		const calls = stubPipeline(202, { runId, status: "stopping" });

		const caller = await adminCaller();
		const result = await caller.admin.sessions.stop({ id: sessionId });
		expect(result.status).toBe("stopping");
		expect((await fixtureSession())?.status).toBe("stopping");
		expect(calls).toHaveLength(1);
	});

	it("re-arms directly to idle when the pipeline holds no such run", async () => {
		const runId = "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";
		await db
			.update(sessions)
			.set({
				status: "error",
				currentRunId: runId,
				lastError: "status_timeout",
			})
			.where(eq(sessions.id, sessionId));
		const calls = stubPipeline(404, { error: "no_such_run" });

		const caller = await adminCaller();
		const result = await caller.admin.sessions.stop({ id: sessionId });
		expect(result.status).toBe("idle");

		const session = await fixtureSession();
		expect(session?.status).toBe("idle");
		expect(session?.lastError).toBeNull();
		expect(calls).toHaveLength(1);
	});
});

describe("admin.ingestToken", () => {
	it("mints a token the pipeline verification accepts", async () => {
		const caller = await adminCaller();
		const { token } = await caller.admin.ingestToken({ sessionId });
		expect(verifyIngestToken(token, sessionId, env.SHARED_SECRET)).toBe(true);
	});
});

describe("admin.events.recent", () => {
	async function insertEvents(count: number) {
		await db.insert(sessionEvents).values(
			Array.from({ length: count }, (_, i) => ({
				sessionId,
				runId: "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77",
				level: "warn" as const,
				code: "chunk_dropped",
				message: `dropped chunk ${i}`,
			})),
		);
	}

	it("returns the latest events for the session, newest first", async () => {
		await insertEvents(3);
		const caller = await adminCaller();
		const events = await caller.admin.events.recent({ sessionId });
		expect(events.map((row) => row.message)).toEqual([
			"dropped chunk 2",
			"dropped chunk 1",
			"dropped chunk 0",
		]);
	});

	it("honours the limit", async () => {
		await insertEvents(5);
		const caller = await adminCaller();
		const events = await caller.admin.events.recent({
			sessionId,
			limit: 2,
		});
		expect(events).toHaveLength(2);
		expect(events[0]?.message).toBe("dropped chunk 4");
	});

	it("throws NOT_FOUND for an unknown session", async () => {
		const caller = await adminCaller();
		await expect(
			caller.admin.events.recent({
				sessionId: "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("admin.pipelineHealth", () => {
	it("proxies GET /healthz and returns the parsed payload", async () => {
		const calls = stubPipeline(200, healthzFixture);
		const caller = await adminCaller();
		const result = await caller.admin.pipelineHealth();
		expect(result).toEqual({ ok: true, health: healthzFixture });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${env.PIPELINE_URL}/healthz`);
		expect(calls[0]?.method).toBe("GET");
	});

	it("reports unreachable instead of throwing when the pipeline is down", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connect ECONNREFUSED");
			}),
		);
		const caller = await adminCaller();
		const result = await caller.admin.pipelineHealth();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("ECONNREFUSED");
	});

	it("reports an invalid body instead of throwing", async () => {
		stubPipeline(200, { status: "ok", contractVersion: 2 });
		const caller = await adminCaller();
		const result = await caller.admin.pipelineHealth();
		expect(result).toEqual({
			ok: false,
			error: "invalid healthz response",
		});
	});
});

describe("admin.onStatus", () => {
	const runId = "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77";

	it("streams status and log events from the status:* topic", async () => {
		const caller = await adminCaller();
		const stream = (await caller.admin.onStatus()) as AsyncIterable<
			[string, Event | { type: "ping" }, null]
		>;
		const iterator = stream[Symbol.asyncIterator]();

		// The generator attaches to the bus when first pulled.
		const firstPromise = iterator.next();
		await new Promise((resolve) => setTimeout(resolve, 10));

		const status: Event = {
			type: "status",
			sessionId,
			runId,
			status: "running",
			stats: {
				audioReceivedMs: 43_000,
				chunksProcessed: 8,
				chunksDropped: 0,
				queueDepth: 0,
				latencyP50Ms: 90,
				latencyP95Ms: 120,
				lastError: null,
			},
			emittedAt: "2026-09-25T14:03:12.400Z",
		};
		const log: Event = {
			type: "log",
			sessionId,
			runId,
			level: "error",
			code: "status_timeout",
			message: "No status event received for 15 s",
			emittedAt: "2026-09-25T14:03:20.000Z",
		};
		publish("status:*", status);
		publish("status:*", log);

		const first = await firstPromise;
		expect(first.value[1]).toEqual(status);
		expect(first.value[0]).toContain(sessionId);
		expect(first.value[0]).toContain(runId);

		const second = await iterator.next();
		expect(second.value[1]).toEqual(log);

		await iterator.return?.();
	});
});
