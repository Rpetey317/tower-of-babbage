#!/usr/bin/env node
/**
 * End-to-end smoke test (docs/testing.md "Smoke test"): drives a real run
 * through the public HTTP surface — admin login, session create/start via
 * tRPC, segment observation over the SSE subscription, SRT export, stop
 * and delete. Implements steps 1-6 of docs/testing.md "Smoke test".
 *
 * Preconditions: Postgres up, web app on WEB_URL, pipeline on PIPELINE_URL
 * with PROVIDER=mock, ADMIN_PASSWORD and SHARED_SECRET exported.
 *
 * Env: WEB_URL (default http://localhost:3000), PIPELINE_URL (default
 * http://localhost:8090), ADMIN_PASSWORD, SHARED_SECRET,
 * SMOKE_SSE_SECONDS (40), SMOKE_MAX_LATENCY_MS (2000),
 * SMOKE_FIXTURE (en-kubernetes-60s.wav).
 *
 * Zero dependencies; requires Node >= 20 for fetch/FormData/getSetCookie.
 * Exit 0 on success, 1 on the first failed step, 2 on bad configuration.
 */

const webUrl = (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const pipelineUrl = (process.env.PIPELINE_URL ?? "http://localhost:8090").replace(/\/+$/, "");
const adminPassword = process.env.ADMIN_PASSWORD;
const sharedSecret = process.env.SHARED_SECRET;
const sseSeconds = Number(process.env.SMOKE_SSE_SECONDS ?? "40");
const maxLatencyMs = Number(process.env.SMOKE_MAX_LATENCY_MS ?? "2000");
const fixturePath = process.env.SMOKE_FIXTURE ?? "en-kubernetes-60s.wav";

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);

class SmokeError extends Error {}

function info(message) {
	console.log(`[${elapsed()}s] ${message}`);
}

function fail(message) {
	throw new SmokeError(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** fetch with a hard timeout so a wedged server fails fast. */
function req(url, init = {}, timeoutMs = 10_000) {
	const ac = new AbortController();
	const timer = setTimeout(
		() => ac.abort(new SmokeError(`${url} timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	return fetch(url, { ...init, signal: ac.signal }).finally(() =>
		clearTimeout(timer),
	);
}

function htmlDecode(value) {
	return value
		.replaceAll("&quot;", '"')
		.replaceAll("&#x27;", "'")
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

// --- tRPC v11 over plain HTTP, superjson envelope ({json: ...}) ---------------

function unwrapTrpc(path, body) {
	const error = body?.error?.json ?? body?.error;
	if (error) {
		fail(`${path}: ${error.message ?? JSON.stringify(error).slice(0, 300)}`);
	}
	const data = body?.result?.data;
	if (!body?.result || data === undefined) {
		fail(`${path}: unexpected response ${JSON.stringify(body).slice(0, 300)}`);
	}
	return data.json ?? data;
}

function trpcQuery(path, input, headers = {}) {
	const url = `${webUrl}/api/trpc/${path}?input=${encodeURIComponent(
		JSON.stringify({ json: input }),
	)}`;
	return req(url, { headers })
		.then((res) => res.json().catch(() => null))
		.then((body) => unwrapTrpc(path, body));
}

async function trpcMutation(path, input, cookie) {
	const res = await req(`${webUrl}/api/trpc/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ json: input }),
	});
	return unwrapTrpc(path, await res.json().catch(() => null));
}

// --- steps -------------------------------------------------------------------

async function preflight() {
	const health = await req(`${webUrl}/api/health`)
		.then((res) => res.json().catch(() => null))
		.catch((error) => fail(`web app unreachable at ${webUrl}: ${error.message}`));
	if (health?.status !== "ok") {
		fail(`${webUrl}/api/health answered ${JSON.stringify(health)}`);
	}

	const healthz = await req(`${pipelineUrl}/healthz`)
		.then((res) => res.json().catch(() => null))
		.catch((error) =>
			fail(`pipeline unreachable at ${pipelineUrl}: ${error.message}`),
		);
	if (healthz?.provider !== "mock") {
		fail(
			`pipeline at ${pipelineUrl} reports provider ${JSON.stringify(healthz?.provider)}; run it with PROVIDER=mock`,
		);
	}
	if (healthz?.contractVersion !== 2) {
		fail(
			`pipeline contractVersion ${JSON.stringify(healthz?.contractVersion)}, expected 2`,
		);
	}

	const sessions = await req(`${pipelineUrl}/v1/sessions`, {
		headers: { authorization: `Bearer ${sharedSecret}` },
	});
	if (sessions.status === 401) {
		fail("pipeline rejected SHARED_SECRET on GET /v1/sessions");
	}
	if (!sessions.ok) {
		fail(`pipeline GET /v1/sessions answered ${sessions.status}`);
	}
}

/**
 * The login form is a server action (`useActionState`): React renders the
 * action reference as hidden $ACTION_* inputs for progressive enhancement.
 * Replaying them verbatim plus the password posts a real form submission;
 * success is a 303 to /admin carrying the tob_admin cookie.
 */
async function login() {
	const page = await req(`${webUrl}/admin/login`);
	if (!page.ok) fail(`GET /admin/login answered ${page.status}`);
	const html = await page.text();
	const form = new FormData();
	let actions = 0;
	for (const match of html.matchAll(/<input([^>]*)>/g)) {
		const attrs = match[1];
		if (!/type="hidden"/.test(attrs)) continue;
		const name = attrs.match(/name="([^"]*)"/)?.[1];
		if (!name) continue;
		if (name.startsWith("$ACTION_")) actions++;
		form.append(name, htmlDecode(attrs.match(/value="([^"]*)"/)?.[1] ?? ""));
	}
	if (actions === 0) {
		fail("no $ACTION_* hidden inputs on /admin/login; cannot submit the form");
	}
	form.append("password", adminPassword);

	const res = await req(`${webUrl}/admin/login`, {
		method: "POST",
		body: form,
		redirect: "manual",
	});
	const cookie = res.headers
		.getSetCookie()
		.find((value) => value.startsWith("tob_admin="));
	if (!cookie) {
		fail(
			`login failed: HTTP ${res.status}, no tob_admin cookie (check ADMIN_PASSWORD)`,
		);
	}
	return cookie.split(";")[0].replace(/^tob_admin="?/, "tob_admin=").replace(/"$/, "");
}

async function createSession(cookie) {
	const slug = `smoke-${Date.now()}`;
	const session = await trpcMutation(
		"admin.sessions.create",
		{
			title: `Smoke test ${slug}`,
			slug,
			roomColor: "violet",
			sourceLanguage: "en",
			targetLanguages: ["es"],
			sourceType: "file_replay",
			sourceConfig: { path: fixturePath, loop: false },
			translationMode: "ast",
		},
		cookie,
	);
	if (!session?.id) fail("admin.sessions.create returned no session id");
	info(`created session ${slug} (${session.id})`);
	return session;
}

async function pollStatus(session, wanted, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	let status = "unknown";
	while (Date.now() < deadline) {
		const row = await trpcQuery("sessions.bySlug", { slug: session.slug });
		status = row?.status ?? "unknown";
		if (wanted.includes(status)) return status;
		if (status === "error") fail(`session went to error while ${what}`);
		await sleep(500);
	}
	fail(`timed out after ${timeoutMs}ms waiting for ${what} (last status: ${status})`);
}

async function startSession(cookie, session) {
	const result = await trpcMutation("admin.sessions.start", { id: session.id }, cookie);
	if (!result?.runId) fail("admin.sessions.start returned no runId");
	await pollStatus(session, ["running"], 10_000, "the session to reach running");
}

/**
 * tRPC subscriptions are SSE: GET with Accept: text/event-stream, blocks of
 * `data: {"json": <event>}` and `id: <tracked id>`; control events are
 * `connected`, `serialized-error` and `return`. Collects until the segment
 * threshold is met or sseSeconds elapse — the chunker emits a segment every
 * ~6-15 s under the default cut rules, so the third pair lands near 30 s.
 */
async function collectSegments(sessionId) {
	const input = encodeURIComponent(
		JSON.stringify({ json: { sessionId, languages: ["en", "es"] } }),
	);
	const ac = new AbortController();
	const window = setTimeout(() => ac.abort(), sseSeconds * 1000);
	const events = [];
	const enough = () => {
		const kinds = { original: 0, translation: 0 };
		for (const event of events) {
			if (event.type === "segment") kinds[event.kind] += 1;
		}
		return kinds.original >= 3 && kinds.translation >= 3;
	};
	try {
		const res = await fetch(
			`${webUrl}/api/trpc/segments.onSegment?input=${input}`,
			{ headers: { accept: "text/event-stream" }, signal: ac.signal },
		);
		if (!res.ok || !res.body) {
			fail(`segments.onSegment answered HTTP ${res.status}`);
		}
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of res.body) {
			buffer += decoder.decode(chunk, { stream: true });
			let index;
			while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
				const block = buffer.slice(0, index);
				buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, "");
				const parsed = parseSseBlock(block);
				if (parsed.event === "serialized-error") {
					fail(`subscription error: ${parsed.data.slice(0, 300)}`);
				}
				if (parsed.event === "return") return events;
				if (!parsed.data) continue;
				const event = JSON.parse(parsed.data).json;
				if (event?.type === "segment" || event?.type === "status") {
					events.push(event);
				}
			}
			if (enough()) return events;
		}
	} catch (error) {
		if (!ac.signal.aborted) throw error;
	} finally {
		clearTimeout(window);
	}
	return events;
}

function parseSseBlock(block) {
	const out = { data: "" };
	for (const line of block.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const field = line.slice(0, colon);
		const value = line.slice(colon + 1).replace(/^ /, "");
		if (field === "data") out.data += (out.data ? "\n" : "") + value;
		else if (field === "event" || field === "id") out[field] = value;
	}
	return out;
}

function checkSegments(events) {
	const segments = events.filter((event) => event.type === "segment");
	const byKind = { original: [], translation: [] };
	for (const segment of segments) byKind[segment.kind]?.push(segment);
	for (const kind of ["original", "translation"]) {
		const list = byKind[kind];
		if (list.length < 3) {
			fail(`only ${list.length} ${kind} segments in ${sseSeconds}s (need >= 3)`);
		}
		for (let i = 1; i < list.length; i++) {
			if (list[i].chunkIndex <= list[i - 1].chunkIndex) {
				fail(
					`${kind} chunkIndex not increasing: ${list[i - 1].chunkIndex} then ${list[i].chunkIndex}`,
				);
			}
		}
	}
	const slow = segments.find((segment) => segment.latencyMs >= maxLatencyMs);
	if (slow) {
		fail(`segment ${slow.chunkIndex} latencyMs ${slow.latencyMs} >= ${maxLatencyMs}`);
	}
	// Contract v2: the mock provider attributes every chunk to a speaker.
	if (!segments.every((segment) => typeof segment.speaker === "string")) {
		fail("some segments arrived without a speaker label");
	}
	info(
		`${byKind.original.length} original + ${byKind.translation.length} translation segments, ` +
			`max latencyMs ${Math.max(...segments.map((s) => s.latencyMs))}`,
	);
}

/**
 * Step 5: stop the run, wait for the last events to land, then download the
 * SRT export for `es` and require at least 3 cues with well-formed,
 * forward-moving timestamps. The export route is public, so no cookie.
 */
async function checkExport(cookie, session) {
	await trpcMutation("admin.sessions.stop", { id: session.id }, cookie);
	await pollStatus(session, ["idle", "error"], 15_000, "the session to settle");

	const res = await req(
		`${webUrl}/api/export/${session.id}?format=srt&lang=es`,
	);
	if (!res.ok) fail(`GET /api/export/${session.id} answered HTTP ${res.status}`);
	const body = await res.text();
	const cues = body.trim() === "" ? [] : body.trim().split(/\r?\n\r?\n/);
	if (cues.length < 3) {
		fail(`export for lang=es has ${cues.length} cues (need >= 3)`);
	}
	const stamp =
		/^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/;
	const toMs = (h, m, s, ms) =>
		((+h * 60 + +m) * 60 + +s) * 1_000 + +ms;
	for (const cue of cues) {
		const lines = cue.split(/\r?\n/);
		const match = lines[1]?.match(stamp);
		if (lines.length < 3 || !match) {
			fail(`malformed export cue: ${cue.slice(0, 80)}`);
		}
		if (toMs(...match.slice(1, 5)) >= toMs(...match.slice(5, 9))) {
			fail(`export cue with non-increasing timestamp: ${match[0]}`);
		}
	}
	info(`export: ${cues.length} cues in ${session.slug}-es.srt`);
}

/** Stop, wait for a deletable status and delete; also the failure cleanup. */
async function teardown(cookie, session) {
	try {
		await trpcMutation("admin.sessions.stop", { id: session.id }, cookie);
	} catch (error) {
		info(`stop: ${error.message} (continuing to delete)`);
	}
	// delete rejects starting|running|stopping, so wait for the pipeline's
	// final status event (or the web watchdog's error) to land first.
	try {
		await pollStatus(session, ["idle", "error"], 15_000, "the session to settle");
	} catch (error) {
		info(`settle: ${error.message} (continuing to delete)`);
	}
	const result = await trpcMutation("admin.sessions.delete", { id: session.id }, cookie);
	if (!result?.deleted) fail("admin.sessions.delete did not confirm");
	info(`deleted session ${session.slug}`);
}

async function step(number, label, fn) {
	const result = await fn();
	info(`step ${number} ${label} — ok`);
	return result;
}

async function main() {
	const missing = ["ADMIN_PASSWORD", "SHARED_SECRET"].filter(
		(name) => !process.env[name],
	);
	if (missing.length) {
		throw new SmokeError(`missing env vars: ${missing.join(", ")}`);
	}
	if (!Number.isFinite(sseSeconds) || sseSeconds <= 0) {
		throw new SmokeError(`SMOKE_SSE_SECONDS must be a positive number`);
	}

	await step(0, "preflight (web health, pipeline healthz+auth)", preflight);
	const cookie = await step(1, "log in at /admin/login", login);
	const session = await step(2, "create file_replay session en->es", () =>
		createSession(cookie),
	);
	let failed;
	try {
		await step(3, "start session, poll until running", () =>
			startSession(cookie, session),
		);
		const events = await step(
			4,
			`watch SSE until 3+3 segments (max ${sseSeconds}s)`,
			() => collectSegments(session.id),
		);
		checkSegments(events);
		await step(5, "stop, export SRT for es (>= 3 cues)", () =>
			checkExport(cookie, session),
		);
	} catch (error) {
		failed = error;
	}
	try {
		await step(6, "stop and delete session", () => teardown(cookie, session));
	} catch (error) {
		info(`teardown failed: ${error.message}`);
	}
	if (failed) throw failed;
}

main()
	.then(() => {
		console.log(`\nsmoke: PASS in ${elapsed()}s`);
	})
	.catch((error) => {
		const detail = error instanceof SmokeError ? error.message : (error?.stack ?? String(error));
		console.error(`\n[${elapsed()}s] smoke: FAIL — ${detail}`);
		process.exitCode = error instanceof SmokeError && error.message.startsWith("missing env") ? 2 : 1;
	});
