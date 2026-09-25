#!/usr/bin/env node
/**
 * Measures real Gemini chunk latency while 1, 2 and 4 file_replay sessions
 * share one pipeline scheduler. A local event receiver replaces the web app
 * so persistence and browser delivery do not affect provider measurements.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pipelineDir = path.join(repoRoot, "services", "pipeline");
const fixture = process.env.BENCH_FIXTURE ?? "en-kubernetes-60s.wav";
const fixturesDir = path.join(repoRoot, "fixtures", "audio");
const provider = process.env.PROVIDER ?? "gemini";
const pipelinePort = Number(process.env.BENCH_PIPELINE_PORT ?? "18090");
const sinkPort = Number(process.env.BENCH_SINK_PORT ?? "18300");
const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? "300000");
const outDir = process.env.BENCH_OUT_DIR ?? path.join(os.tmpdir(), "tower-of-babbage-latency");
const loads = (process.env.BENCH_LOADS ?? "1,2,4").split(",").map(Number);
const secret = process.env.SHARED_SECRET;

class BenchmarkError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = (url, init = {}, timeout = 10_000) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);
	return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
};

function percentile(values, percent) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)];
}

function startEventSink() {
	const events = [];
	const server = http.createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/api/internal/events") {
			res.writeHead(404).end();
			return;
		}
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
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(sinkPort, "127.0.0.1", () => resolve({ server, events }));
	});
}

function buildPipeline() {
	if (process.env.PIPELINE_BIN) return process.env.PIPELINE_BIN;
	const bin = path.join(outDir, "pipeline");
	const result = spawnSync("go", ["build", "-o", bin, "./cmd/pipeline"], {
		cwd: pipelineDir,
		encoding: "utf8",
	});
	if (result.status !== 0) throw new BenchmarkError(`go build failed:\n${result.stderr}`);
	return bin;
}

function spawnPipeline(bin) {
	const child = spawn(bin, [], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			LISTEN_ADDR: `127.0.0.1:${pipelinePort}`,
			WEB_URL: `http://127.0.0.1:${sinkPort}`,
			PROVIDER: provider,
			FIXTURES_DIR: fixturesDir,
		},
	});
	const output = [];
	child.stdout.on("data", (chunk) => output.push(chunk));
	child.stderr.on("data", (chunk) => output.push(chunk));
	return { child, output };
}

async function waitHealthy(child) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new BenchmarkError(`pipeline exited (${child.exitCode}) before ready`);
		const health = await request(`http://127.0.0.1:${pipelinePort}/healthz`)
			.then((res) => (res.ok ? res.json() : null))
			.catch(() => null);
		if (health?.provider === provider) return;
		await sleep(250);
	}
	throw new BenchmarkError("pipeline did not become healthy within 15 seconds");
}

async function stopPipeline(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const exited = await Promise.race([
		new Promise((resolve) => child.once("exit", () => resolve(true))),
		sleep(5000).then(() => false),
	]);
	if (!exited) child.kill("SIGKILL");
}

async function runLoad(bin, sink, count) {
	const pipeline = spawnPipeline(bin);
	const { child } = pipeline;
	const sessions = Array.from({ length: count }, (_, index) => ({
		sessionId: `latency-bench-${count}-${index + 1}`,
		runId: randomUUID(),
	}));
	const startedAt = Date.now();
	try {
		await waitHealthy(child);
		const starts = await Promise.all(
			sessions.map(async ({ sessionId, runId }) => {
				const response = await request(
					`http://127.0.0.1:${pipelinePort}/v1/sessions/${sessionId}/start`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${secret}`,
						},
						body: JSON.stringify({
							contractVersion: 2,
							runId,
							slug: sessionId,
							sourceLanguage: "en",
							targetLanguages: ["es"],
							translationMode: "ast",
							source: { type: "file_replay", config: { path: fixture, loop: false } },
							glossary: [],
						}),
					},
					30_000,
				);
				if (!response.ok) {
					throw new BenchmarkError(`start ${sessionId} returned ${response.status}: ${await response.text()}`);
				}
			}),
		);
		void starts;

		const deadline = Date.now() + timeoutMs;
		const terminal = new Map();
		while (Date.now() < deadline && terminal.size < count) {
			for (const session of sessions) {
				if (terminal.has(session.runId)) continue;
				const status = sink.events.find(
					(event) => event.type === "status" && event.runId === session.runId && ["idle", "error"].includes(event.status),
				);
				if (status) terminal.set(session.runId, status);
			}
			if (terminal.size < count) await sleep(250);
		}
		if (terminal.size < count) throw new BenchmarkError(`${terminal.size}/${count} sessions reached a terminal status within ${timeoutMs}ms`);

		const runs = sessions.map((session) => {
			const events = sink.events.filter((event) => event.runId === session.runId);
			const segments = events.filter((event) => event.type === "segment");
			const latencies = segments.map((event) => event.latencyMs);
			const status = terminal.get(session.runId);
			return {
				sessionId: session.sessionId,
				status: status.status,
				audioMs: status.stats?.audioReceivedMs ?? 0,
				chunksProcessed: status.stats?.chunksProcessed ?? new Set(segments.map((event) => event.chunkIndex)).size,
				chunksDropped: status.stats?.chunksDropped ?? 0,
				segmentCount: segments.length,
				parseFailures: events.filter((event) => event.type === "log" && event.code === "provider_bad_output").length,
				p50Ms: percentile(latencies, 50),
				p95Ms: percentile(latencies, 95),
				latencies,
			};
		});
		const allLatencies = runs.flatMap((run) => run.latencies);
		const result = {
			sessions: count,
			wallSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
			status: runs.every((run) => run.status === "idle") ? "idle" : "error",
			chunksProcessed: runs.reduce((total, run) => total + run.chunksProcessed, 0),
			chunksDropped: runs.reduce((total, run) => total + run.chunksDropped, 0),
			segmentCount: runs.reduce((total, run) => total + run.segmentCount, 0),
			parseFailures: runs.reduce((total, run) => total + run.parseFailures, 0),
			p50Ms: percentile(allLatencies, 50),
			p95Ms: percentile(allLatencies, 95),
			perSession: runs.map(({ latencies: _latencies, ...run }) => run),
		};
		return result;
	} finally {
		await stopPipeline(child);
		writeFileSync(path.join(outDir, `pipeline-${count}-sessions.log`), Buffer.concat(pipeline.output));
		const retained = sink.events.filter((event) => !sessions.some((session) => session.runId === event.runId));
		sink.events.splice(0, sink.events.length, ...retained);
	}
}

function reportMarkdown(results) {
	const lines = [
		"# Gemini replay latency benchmark",
		"",
		`- Date (UTC): ${new Date().toISOString()}`,
		`- Fixture: \`${fixture}\` (${loads.length} concurrent-load scenarios)`,
		`- Provider: \`${provider}\`; model: \`${process.env.GEMINI_MODEL ?? "pipeline default"}\``,
		`- Pipeline request concurrency: ${process.env.INFERENCE_MAX_CONCURRENCY ?? "pipeline default (2)"}`,
		"- Replay source: paced WAV file replay; each load is a fresh pipeline process.",
		"- Event receiver: local in-memory HTTP sink; database and audience SSE are excluded.",
		"",
		"| Sessions | Wall time (s) | Chunks | Segments | p50 latency (ms) | p95 latency (ms) | Dropped | Parse failures | Result |",
		"| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
	];
	for (const result of results) {
		lines.push(`| ${result.sessions} | ${result.wallSeconds} | ${result.chunksProcessed} | ${result.segmentCount} | ${result.p50Ms ?? "n/a"} | ${result.p95Ms ?? "n/a"} | ${result.chunksDropped} | ${result.parseFailures} | ${result.status} |`);
	}
	lines.push("", "## Per-session p95 latency", "", "| Load | Session | Chunks | Segments | p50 (ms) | p95 (ms) | Dropped | Status |", "| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |");
	for (const result of results) {
		for (const session of result.perSession) {
			lines.push(`| ${result.sessions} | ${session.sessionId} | ${session.chunksProcessed} | ${session.segmentCount} | ${session.p50Ms ?? "n/a"} | ${session.p95Ms ?? "n/a"} | ${session.chunksDropped} | ${session.status} |`);
		}
	}
	lines.push("", "Latency values are the pipeline's end-to-end chunk latencies: chunk audio end to emitted caption event. Percentiles use nearest-rank across all original and translation segment events in that load.", "");
	return lines.join("\n");
}

async function main() {
	if (provider !== "gemini") throw new BenchmarkError("M2-04 requires PROVIDER=gemini");
	if (!loads.length || loads.some((count) => ![1, 2, 4].includes(count))) throw new BenchmarkError("BENCH_LOADS must be a comma-separated subset of 1,2,4");
	if (!secret || !process.env.GEMINI_API_KEY) throw new BenchmarkError("SHARED_SECRET and GEMINI_API_KEY are required; source services/pipeline/.env first");
	if (!Number.isInteger(pipelinePort) || !Number.isInteger(sinkPort) || pipelinePort < 1 || sinkPort < 1) throw new BenchmarkError("benchmark ports must be positive integers");
	if (pipelinePort === sinkPort) throw new BenchmarkError("BENCH_PIPELINE_PORT and BENCH_SINK_PORT must differ");
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new BenchmarkError("BENCH_TIMEOUT_MS must be at least 1000");
	mkdirSync(outDir, { recursive: true });
	const bin = buildPipeline();
	const sink = await startEventSink();
	const results = [];
	try {
		for (const count of loads) {
			console.log(`Running ${count} concurrent Gemini replay session${count === 1 ? "" : "s"}...`);
			const result = await runLoad(bin, sink, count);
			results.push(result);
			console.log(`  ${result.wallSeconds}s wall; ${result.segmentCount} segments; p50 ${result.p50Ms ?? "n/a"}ms; p95 ${result.p95Ms ?? "n/a"}ms; status ${result.status}`);
		}
	} finally {
		await new Promise((resolve) => sink.server.close(resolve));
	}
	const report = reportMarkdown(results);
	const reportPath = path.join(outDir, "benchmark.md");
	writeFileSync(reportPath, `${report}\n`);
	writeFileSync(path.join(outDir, "benchmark.json"), `${JSON.stringify(results, null, 2)}\n`);
	console.log(`\n${report}\n`);
	console.log(`Artifacts: ${reportPath} and ${path.join(outDir, "benchmark.json")}`);
	if (results.some((result) => result.status !== "idle" || result.segmentCount === 0 || result.parseFailures > 0)) {
		throw new BenchmarkError("one or more benchmark loads had an error, no segments, or provider parse failures; see the report and pipeline logs");
	}
}

main().catch((error) => {
	console.error(`\nbench-latency: FAIL — ${error?.stack ?? error}`);
	process.exitCode = 1;
});
