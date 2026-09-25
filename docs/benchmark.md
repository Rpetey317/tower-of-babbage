# Gemini replay latency benchmark

## Results

Measured on 2026-09-25 UTC with `gemini-3.8-flash`, `INFERENCE_MAX_CONCURRENCY=2`, and the English-to-Spanish AST path. Each load used a fresh pipeline process and replayed `fixtures/audio/en-kubernetes-60s.wav` (62.193 seconds by `ffprobe`). The replay sessions in each load started together.

| Replay sessions | Wall time (s) | Chunks | Segments | Aggregate p50 (ms) | Aggregate p95 (ms) | Worst session p95 (ms) | Dropped chunks | Parse failures |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 64.4 | 7 | 14 | 2,055 | 3,921 | 3,921 | 0 | 0 |
| 2 | 65.4 | 14 | 28 | 2,752 | 6,946 | 6,946 | 0 | 0 |
| 4 | 67.2 | 28 | 56 | 3,284 | 5,839 | 6,355 | 0 | 0 |

Per-session p95 latency shows the spread behind the aggregate values:

| Replay sessions | Session | Chunks | p50 (ms) | p95 (ms) | Dropped chunks | Result |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | `latency-bench-1-1` | 7 | 2,055 | 3,921 | 0 | idle |
| 2 | `latency-bench-2-1` | 7 | 2,204 | 3,204 | 0 | idle |
| 2 | `latency-bench-2-2` | 7 | 3,159 | 6,946 | 0 | idle |
| 4 | `latency-bench-4-1` | 7 | 5,601 | 6,355 | 0 | idle |
| 4 | `latency-bench-4-2` | 7 | 2,284 | 3,897 | 0 | idle |
| 4 | `latency-bench-4-3` | 7 | 4,773 | 5,739 | 0 | idle |
| 4 | `latency-bench-4-4` | 7 | 2,997 | 4,519 | 0 | idle |

All sessions reached `idle`; no chunks were dropped and the provider output parser reported no failures. Aggregate and per-session p95 stayed below the 10-second dashboard alarm through four sessions. The four-session group processed 248.8 seconds of audio in 67.2 seconds wall time (about 3.7x aggregate real time).

Latency is the pipeline's chunk end-to-caption emission latency. Percentiles use nearest-rank over segment events for each load; original and translation events for a chunk carry the same latency, so each chunk appears twice. Wall time includes process startup, replay, inference, and event delivery to the local receiver.

## Environment

- Linux x86_64 under WSL2 (`6.6.87.2-microsoft-standard-WSL2`)
- AMD Ryzen 7 5800XT, 8 cores / 16 threads; 15 GiB RAM
- Go 1.27.0, Node.js 22.22.2
- Gemini API provider, model `gemini-3.8-flash`
- Pipeline inference concurrency: 2 shared requests
- Pipeline chunk settings: repository defaults (2-second minimum, 6-second target, 15-second maximum)

The pipeline ran on the local CPU and sent model requests to Gemini over the network. The harness used an in-memory local HTTP event receiver instead of the web app, so database persistence and browser SSE delivery are excluded. Before the final measurements, I stopped three stale host pipeline processes, the web server, and the old `llama-cpu` and Postgres containers from the sibling checkout. No other Tower of Babbage app process or container was running during the measured loads.

## Reproduce

From the repository root, load the pipeline environment and run the default 1, 2, and 4 session sequence:

```bash
set -a
. services/pipeline/.env
set +a
./scripts/bench-latency.sh
```

The environment must define `SHARED_SECRET` and `GEMINI_API_KEY`; the pipeline environment file supplies both in this setup. The script requires Go, Node.js, and `ffmpeg`. It builds a temporary pipeline binary, starts an isolated pipeline and event receiver on `127.0.0.1:18090` and `127.0.0.1:18300`, then stops the pipeline after each run. Set `BENCH_PIPELINE_PORT` or `BENCH_SINK_PORT` to use different free ports. `BENCH_OUT_DIR` changes the artifact directory (default `/tmp/tower-of-babbage-latency`); the directory contains the Markdown/JSON output and per-load pipeline logs.

To rerun selected loads, set `BENCH_LOADS=1`, `2`, `4`, or a comma-separated subset such as `2,4`. Leave it unset for the full acceptance run. `BENCH_TIMEOUT_MS` controls the maximum wait for each session to finish.

The benchmark sends fixture audio to Gemini and may incur API usage charges. It reports latency; it does not gate on the 10-second target.
