#!/usr/bin/env node
/**
 * Language-pair quality check (roadmap M6, docs/components/languages.md):
 * replays one audio fixture through a real pipeline and measures transcript
 * WER and segment latency for a source -> target pair.
 *
 * The script spawns the pipeline binary on its own ports, stands in for the
 * web app with a minimal /api/internal/events sink, starts a file_replay
 * session through the control API and collects the emitted segments.
 * Transcript, translation and a results summary land in OUT_DIR; WER is
 * computed with scripts/wer.mjs against the fixture's ground-truth .txt.
 *
 * Usage: source services/pipeline/.env, then
 *   node scripts/language-quality.mjs <fixture.wav> <source> <target>
 * Example: node scripts/language-quality.mjs pt-sample-30s.wav pt es
 *
 * Env: SHARED_SECRET (required), PROVIDER (gemini; openai-compat and mock also
 * work), GEMINI_API_KEY (required for PROVIDER=gemini), GEMINI_MODEL,
 * PIPELINE_PORT (8093), SINK_PORT (8393), PIPELINE_BIN (skip `go build`),
 * OUT_DIR (default $TMPDIR/tower-of-babbage-language-quality),
 * RUN_TIMEOUT_MS (300000).
 *
 * Zero dependencies; requires Node >= 20 and Go on PATH.
 * Exit 0 when the run completes — this records measurements, not a gate;
 * exit 2 on bad configuration, 1 on a failed run.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(repoRoot, "fixtures", "audio");
const werScript = path.join(repoRoot, "scripts", "wer.mjs");
const outDir =
	process.env.OUT_DIR ??
	path.join(os.tmpdir(), "tower-of-babbage-language-quality");
const provider = process.env.PROVIDER ?? "gemini";
const pipelinePort = Number(process.env.PIPELINE_PORT ?? "8093");
const sinkPort = Number(process.env.SINK_PORT ?? "8393");
const runTimeoutMs = Number(process.env.RUN_TIMEOUT_MS ?? "300000");

const sharedSecret = process.env.SHARED_SECRET;

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

function spawnPipeline(bin) {
	const env = {
		...process.env,
		LISTEN_ADDR: `127.0.0.1:${pipelinePort}`,
		WEB_URL: `http://127.0.0.1:${sinkPort}`,
		PROVIDER: provider,
		FIXTURES_DIR: fixturesDir,
	};
	const child = spawn(bin, [], { env });
	const log = path.join(outDir, "pipeline.log");
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
		if (healthz?.provider === provider) return;
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

async function runCheck(bin, sink, fixture, source, target) {
	const child = spawnPipeline(bin);
	const sessionId = `language-check-${source}-${target}`;
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
					slug: sessionId,
					sourceLanguage: source,
					targetLanguages: [target],
					translationMode: "ast",
					source: {
						type: "file_replay",
						config: { path: fixture, loop: false },
					},
					glossary: [],
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

	const base = `${fixture.replace(/\.wav$/i, "")}.${source}-${target}`;
	writeFileSync(path.join(outDir, `${base}.events.json`), JSON.stringify(events, null, 2));
	writeFileSync(path.join(outDir, `${base}.original.txt`), `${transcript}\n`);
	writeFileSync(path.join(outDir, `${base}.${target}.txt`), `${translation}\n`);

	const groundTruth = path.join(fixturesDir, fixture.replace(/\.wav$/i, ".txt"));
	return {
		fixture,
		transcript,
		translation,
		segments: segments.length,
		latencyP50: percentile(50),
		latencyP95: percentile(95),
		parseFailures: logs.filter((log) => log.code === "provider_bad_output").length,
		terminalStatus: terminal.status,
		wer: existsSync(groundTruth)
			? runWer(path.join(outDir, `${base}.original.txt`), groundTruth)
			: { pct: null, raw: `no ground truth at ${groundTruth}` },
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

// --- main --------------------------------------------------------------------

async function main() {
	const [fixture, source, target] = process.argv.slice(2);
	if (!fixture || !source || !target) {
		throw new CheckError(
			`usage: ${process.argv[1]} <fixture.wav> <source lang> <target lang>`,
		);
	}
	if (!existsSync(path.join(fixturesDir, fixture))) {
		throw new CheckError(`fixture not found: ${path.join(fixturesDir, fixture)}`);
	}
	const missing = ["SHARED_SECRET"];
	if (provider === "gemini") missing.push("GEMINI_API_KEY");
	const absent = missing.filter((name) => !process.env[name]);
	if (absent.length) {
		throw new CheckError(
			`missing env vars: ${absent.join(", ")} (source services/pipeline/.env first)`,
		);
	}

	mkdirSync(outDir, { recursive: true });
	const bin = buildPipeline();
	info(`pipeline binary: ${bin} (provider ${provider})`);
	const sink = await startSink();
	info(`events sink on http://127.0.0.1:${sinkPort}/api/internal/events`);

	let failure;
	try {
		info(`replaying ${fixture} ${source} -> ${target}`);
		const result = await runCheck(bin, sink, fixture, source, target);

		const lines = [
			`# Language quality check: ${fixture} ${source} -> ${target}`,
			"",
			`- provider: ${provider}`,
			`- segments: ${result.segments}, status ${result.terminalStatus}, ` +
				`p50 ${result.latencyP50}ms, p95 ${result.latencyP95}ms, ` +
				`parse failures ${result.parseFailures}`,
			result.wer.pct === null
				? `- WER: unavailable (${result.wer.raw ?? "no output"})`
				: `- WER: ${result.wer.pct}% (${result.wer.errors}/${result.wer.words} words)`,
			"",
			`transcript (${source}): ${result.transcript}`,
			"",
			`translation (${target}): ${result.translation}`,
			"",
		];
		const report = lines.join("\n");
		writeFileSync(path.join(outDir, "results.md"), report);
		console.log(`\n${report}`);
	} catch (error) {
		failure = error;
	} finally {
		sink.server.close();
	}
	info(`artifacts in ${outDir}`);
	if (failure) throw failure;
}

main().catch((error) => {
	const detail =
		error instanceof CheckError ? error.message : (error?.stack ?? String(error));
	console.error(`\n[${elapsed()}s] language-quality: FAIL — ${detail}`);
	process.exitCode =
		error instanceof CheckError && error.message.startsWith("missing env") ? 2 : 1;
});
