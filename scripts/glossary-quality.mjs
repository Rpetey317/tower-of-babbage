#!/usr/bin/env node
/**
 * Glossary quality check (roadmap M4-03, docs/components/glossary.md):
 * replays fixtures through a real pipeline running PROVIDER=gemini and
 * measures what the glossary does to spellings and WER.
 *
 * For each scenario the script spawns the pipeline binary on its own ports,
 * stands in for the web app with a minimal /api/internal/events sink, starts
 * a file_replay session through the control API and collects the emitted
 * segments. Transcripts and a results table land in the output dir; run
 * scripts/wer.mjs is invoked per scenario for the WER numbers.
 *
 * Scenarios: the en-glossary-30s fixture without a glossary, with
 * [kubectl, etcd, Nerdearla], and with the glossary plus GLOSSARY_ENFORCE;
 * plus the en-kubernetes-60s fixture with and without that glossary (its
 * terms are absent there, which checks that an unused glossary does not
 * distort output).
 *
 * Usage: source services/pipeline/.env, then
 *   node scripts/glossary-quality.mjs [scenario ...]
 *
 * Env: SHARED_SECRET and GEMINI_API_KEY (required), GEMINI_MODEL,
 * PIPELINE_PORT (8091), SINK_PORT (8399), PIPELINE_BIN (skip `go build`),
 * OUT_DIR (default $TMPDIR/tower-of-babbage-glossary-quality),
 * RUN_TIMEOUT_MS (300000).
 *
 * Zero dependencies; requires Node >= 20 and Go on PATH.
 * Exit 0 always once checks run — this records measurements, not a gate;
 * exit 2 on bad configuration, 1 on an aborted scenario.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(repoRoot, "fixtures", "audio");
const werScript = path.join(repoRoot, "scripts", "wer.mjs");
const outDir =
	process.env.OUT_DIR ??
	path.join(os.tmpdir(), "tower-of-babbage-glossary-quality");
const pipelinePort = Number(process.env.PIPELINE_PORT ?? "8091");
const sinkPort = Number(process.env.SINK_PORT ?? "8399");
const runTimeoutMs = Number(process.env.RUN_TIMEOUT_MS ?? "300000");

const sharedSecret = process.env.SHARED_SECRET;

const glossary = ["kubectl", "etcd", "Nerdearla"].map((term) => ({
	term,
	translation: null,
}));

const scenarios = [
	{
		name: "glossary-terms-no-glossary",
		fixture: "en-glossary-30s.wav",
		groundTruth: "en-glossary-30s.txt",
		glossary: [],
		enforce: false,
	},
	{
		name: "glossary-terms-with-glossary",
		fixture: "en-glossary-30s.wav",
		groundTruth: "en-glossary-30s.txt",
		glossary,
		enforce: false,
	},
	{
		name: "glossary-terms-enforce",
		fixture: "en-glossary-30s.wav",
		groundTruth: "en-glossary-30s.txt",
		glossary,
		enforce: true,
	},
	{
		name: "kubernetes-no-glossary",
		fixture: "en-kubernetes-60s.wav",
		groundTruth: "en-kubernetes-60s.txt",
		glossary: [],
		enforce: false,
	},
	{
		name: "kubernetes-absent-glossary",
		fixture: "en-kubernetes-60s.wav",
		groundTruth: "en-kubernetes-60s.txt",
		glossary,
		enforce: false,
	},
];

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);

class CheckError extends Error {}

function info(message) {
	console.log(`[${elapsed()}s] ${message}`);
}

function req(url, init = {}, timeoutMs = 10_000) {
	const ac = new AbortController();
	const timer = setTimeout(
		() => ac.abort(new CheckError(`${url} timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	return fetch(url, { ...init, signal: ac.signal }).finally(() =>
		clearTimeout(timer),
	);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- events sink: minimal stand-in for the web app's events endpoint --------

function startSink() {
	const events = [];
	const server = http.createServer((req, res) => {
		if (req.method === "POST" && req.url === "/api/internal/events") {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				try {
					const batch = JSON.parse(body);
					events.push(...(batch.events ?? []));
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ accepted: batch.events?.length ?? 0 }));
				} catch {
					res.writeHead(400).end();
				}
			});
			return;
		}
		res.writeHead(404).end();
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(sinkPort, "127.0.0.1", () => resolve({ server, events }));
	});
}

// --- pipeline lifecycle ------------------------------------------------------

function buildPipeline() {
	if (process.env.PIPELINE_BIN) return process.env.PIPELINE_BIN;
	const bin = path.join(outDir, "pipeline");
	const build = spawnSync("go", ["build", "-o", bin, "./cmd/pipeline"], {
		cwd: path.join(repoRoot, "services", "pipeline"),
		encoding: "utf8",
	});
	if (build.status !== 0) {
		throw new CheckError(`go build failed:\n${build.stderr}`);
	}
	return bin;
}

function spawnPipeline(bin, scenario) {
	const env = {
		...process.env,
		LISTEN_ADDR: `127.0.0.1:${pipelinePort}`,
		WEB_URL: `http://127.0.0.1:${sinkPort}`,
		PROVIDER: "gemini",
		FIXTURES_DIR: fixturesDir,
		GLOSSARY_ENFORCE: scenario.enforce ? "true" : "false",
	};
	const child = spawn(bin, [], { env });
	const log = path.join(outDir, `${scenario.name}.pipeline.log`);
	const stream = [];
	child.stdout.on("data", (chunk) => stream.push(chunk));
	child.stderr.on("data", (chunk) => stream.push(chunk));
	child.on("exit", () => writeFileSync(log, Buffer.concat(stream)));
	return child;
}

async function waitHealthy() {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const healthz = await req(`http://127.0.0.1:${pipelinePort}/healthz`)
			.then((res) => res.json().catch(() => null))
			.catch(() => null);
		if (healthz?.provider === "gemini") return;
		await sleep(250);
	}
	throw new CheckError("pipeline did not become healthy within 15s");
}

async function stopPipeline(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const exited = await Promise.race([
		new Promise((resolve) => child.once("exit", () => resolve(true))),
		sleep(5_000).then(() => false),
	]);
	if (!exited) child.kill("SIGKILL");
}

// --- one replay run ----------------------------------------------------------

async function runScenario(bin, sink, scenario) {
	const child = spawnPipeline(bin, scenario);
	const sessionId = `glossary-check-${scenario.name}`;
	const runId = randomUUID();
	let terminal;
	try {
		await waitHealthy();
		const res = await req(
			`http://127.0.0.1:${pipelinePort}/v1/sessions/${sessionId}/start`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${sharedSecret}`,
				},
				body: JSON.stringify({
					contractVersion: 1,
					runId,
					slug: scenario.name,
					sourceLanguage: "en",
					targetLanguages: ["es"],
					translationMode: "ast",
					source: {
						type: "file_replay",
						config: { path: scenario.fixture, loop: false },
					},
					glossary: scenario.glossary,
				}),
			},
			30_000,
		);
		if (!res.ok) {
			throw new CheckError(`start answered ${res.status}: ${await res.text()}`);
		}

		const deadline = Date.now() + runTimeoutMs;
		while (Date.now() < deadline) {
			terminal = sink.events.find(
				(event) =>
					event.type === "status" &&
					event.runId === runId &&
					["idle", "error"].includes(event.status),
			);
			if (terminal) break;
			await sleep(500);
		}
		if (!terminal) {
			throw new CheckError(`no terminal status within ${runTimeoutMs}ms`);
		}
	} finally {
		await stopPipeline(child);
	}

	const events = sink.events.filter((event) => event.runId === runId);
	sink.events.length = 0;
	const segments = events
		.filter((event) => event.type === "segment")
		.sort((a, b) => a.chunkIndex - b.chunkIndex || a.kind.localeCompare(b.kind));
	const transcript = segments
		.filter((event) => event.kind === "original")
		.map((event) => event.text)
		.join(" ");
	const translation = segments
		.filter((event) => event.kind === "translation")
		.map((event) => event.text)
		.join(" ");
	const logs = events.filter((event) => event.type === "log");
	const latencies = segments.map((event) => event.latencyMs).sort((a, b) => a - b);
	const percentile = (p) =>
		latencies.length
			? latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)]
			: null;

	writeFileSync(
		path.join(outDir, `${scenario.name}.events.json`),
		JSON.stringify(events, null, 2),
	);
	writeFileSync(path.join(outDir, `${scenario.name}.original.txt`), `${transcript}\n`);
	writeFileSync(path.join(outDir, `${scenario.name}.es.txt`), `${translation}\n`);

	return {
		scenario,
		transcript,
		segments: segments.length,
		latencyP50: percentile(50),
		latencyP95: percentile(95),
		parseFailures: logs.filter((log) => log.code === "provider_bad_output").length,
		terminalStatus: terminal.status,
		wer: runWer(
			path.join(outDir, `${scenario.name}.original.txt`),
			path.join(fixturesDir, scenario.groundTruth),
		),
	};
}

function runWer(hypothesis, reference) {
	const run = spawnSync("node", [werScript, hypothesis, reference], {
		encoding: "utf8",
	});
	const match = run.stdout.match(/WER: ([\d.]+)% \((\d+)\/(\d+)\)/);
	return match
		? { pct: Number(match[1]), errors: Number(match[2]), words: Number(match[3]) }
		: { pct: null, raw: (run.stdout + run.stderr).trim() };
}

// --- spelling extraction -----------------------------------------------------

/**
 * Surface forms each glossary term took in the transcript: exact
 * case-insensitive hits plus near misses (normalized tokens within a small
 * edit distance, or two consecutive tokens that combine to the term, like
 * "cube CTL"). The raw transcripts sit next to the report for manual review.
 */
function termSpellings(transcript, terms) {
	const tokens = transcript
		.split(/\s+/)
		.map((raw) => ({ raw, norm: raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") }))
		.filter((token) => token.norm !== "");
	const levenshtein = (a, b) => {
		const dp = Array.from({ length: a.length + 1 }, (_, i) =>
			Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
		);
		for (let i = 1; i <= a.length; i++)
			for (let j = 1; j <= b.length; j++)
				dp[i][j] = Math.min(
					dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
					dp[i - 1][j] + 1,
					dp[i][j - 1] + 1,
				);
		return dp[a.length][b.length];
	};
	const report = {};
	for (const { term } of terms) {
		const wanted = term.toLowerCase();
		const maxDist = wanted.length <= 4 ? 1 : 2;
		const found = new Map();
		for (let i = 0; i < tokens.length; i++) {
			const forms = [tokens[i].raw];
			if (i + 1 < tokens.length) {
				const joined = tokens[i].norm + tokens[i + 1].norm;
				if (Math.abs(joined.length - wanted.length) <= maxDist + 1) {
					forms.push(`${tokens[i].raw} ${tokens[i + 1].raw}`);
				}
			}
			for (const form of forms) {
				const norm = form.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
				if (norm === "" || Math.abs(norm.length - wanted.length) > maxDist) continue;
				if (norm === wanted || levenshtein(norm, wanted) <= maxDist) {
					found.set(form, (found.get(form) ?? 0) + 1);
				}
			}
		}
		report[term] = [...found.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([form, count]) => (count > 1 ? `${form} ×${count}` : form));
	}
	return report;
}

// --- main --------------------------------------------------------------------

async function main() {
	const missing = ["SHARED_SECRET", "GEMINI_API_KEY"].filter(
		(name) => !process.env[name],
	);
	if (missing.length) {
		throw new CheckError(
			`missing env vars: ${missing.join(", ")} (source services/pipeline/.env first)`,
		);
	}

	const wanted = process.argv.slice(2);
	const list = wanted.length
		? scenarios.filter((scenario) => wanted.includes(scenario.name))
		: scenarios;
	if (list.length === 0) {
		throw new CheckError(
			`no matching scenario; available: ${scenarios.map((s) => s.name).join(", ")}`,
		);
	}

	mkdirSync(outDir, { recursive: true });
	const bin = buildPipeline();
	info(`pipeline binary: ${bin}`);
	const sink = await startSink();
	info(`events sink on http://127.0.0.1:${sinkPort}/api/internal/events`);

	const results = [];
	let failure;
	try {
		for (const scenario of list) {
			info(`scenario ${scenario.name}: replaying ${scenario.fixture}`);
			try {
				const result = await runScenario(bin, sink, scenario);
				results.push(result);
				info(
					`${scenario.name}: ${result.segments} segments, ` +
						`WER ${result.wer.pct ?? "?"}%, p95 ${result.latencyP95}ms`,
				);
			} catch (error) {
				sink.events.length = 0;
				info(`${scenario.name}: FAILED — ${error.message}`);
				failure = error;
			}
		}
	} finally {
		sink.server.close();
	}

	const lines = ["# Glossary quality check", ""];
	for (const result of results) {
		const spellings = termSpellings(result.transcript, glossary);
		lines.push(`## ${result.scenario.name}`);
		lines.push("");
		lines.push(`- fixture: ${result.scenario.fixture}`);
		lines.push(
			`- glossary: ${
				result.scenario.glossary.length
					? result.scenario.glossary.map((t) => t.term).join(", ")
					: "(none)"
			}${result.scenario.enforce ? " + GLOSSARY_ENFORCE" : ""}`,
		);
		lines.push(
			`- segments: ${result.segments}, status ${result.terminalStatus}, ` +
				`p50 ${result.latencyP50}ms, p95 ${result.latencyP95}ms, ` +
				`parse failures ${result.parseFailures}`,
		);
		lines.push(
			result.wer.pct === null
				? `- WER: unavailable (${result.wer.raw ?? "no output"})`
				: `- WER: ${result.wer.pct}% (${result.wer.errors}/${result.wer.words} words)`,
		);
		for (const [term, forms] of Object.entries(spellings)) {
			lines.push(`- \`${term}\` as: ${forms.length ? forms.join(", ") : "(not found)"}`);
		}
		lines.push("");
		lines.push(`transcript: ${result.transcript}`);
		lines.push("");
	}
	const report = lines.join("\n");
	writeFileSync(path.join(outDir, "results.md"), report);
	console.log(`\n${report}`);
	info(`artifacts in ${outDir}`);
	if (failure) throw failure;
}

main().catch((error) => {
	const detail =
		error instanceof CheckError ? error.message : (error?.stack ?? String(error));
	console.error(`\n[${elapsed()}s] glossary-quality: FAIL — ${detail}`);
	process.exitCode =
		error instanceof CheckError && error.message.startsWith("missing env") ? 2 : 1;
});
