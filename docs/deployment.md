# Deployment

How to run Tower of Babbage for development, for the Vibeathon demo and for a
conference. Topologies are described in [architecture.md](architecture.md);
every variable is listed in [stack.md](stack.md).

## Services (`infra/compose.yml`)

| Service | Image | Ports | Profile |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine`, volume `pgdata` | 5432 | `infra`, `all` |
| `llama` | `ghcr.io/ggml-org/llama.cpp:server-vulkan` (or `server-cuda`, `server` for CPU) | 8080 | `infra`, `all` |
| `llama-cpu` | `ghcr.io/ggml-org/llama.cpp:server` | 8080 | `cpu` |
| `pipeline` | built from `services/pipeline/Dockerfile` (distroless, includes ffmpeg) | 8090 | `all` |
| `web` | built from `apps/web/Dockerfile` (Next.js standalone output) | 3000 | `all` |

`make infra-up` runs profile `infra` (development: web and pipeline run from
source). It selects the Vulkan service when `/dev/dri` exists and otherwise
uses the CPU service. Set `LLAMA_SERVICE=llama` or `LLAMA_SERVICE=llama-cpu`
to override detection. Both development ports bind to `127.0.0.1` by default;
set `LLAMA_BIND_HOST` to the GPU box's LAN address when another machine needs
to reach inference. Change `POSTGRES_BIND_HOST` only when remote database access
is required. Docker Desktop on WSL2 exposes AMD GPUs as `/dev/dxg`,
which the Vulkan image cannot use, so it selects CPU. Native Linux is required
for the RX 6600 Vulkan path. `docker compose -f infra/compose.yml --profile all
up -d` runs the complete GPU stack for an event. Health checks: `pg_isready`,
`GET :8080/health`, `GET :8090/healthz`, `GET :3000/api/health`.

Secrets and hosts come from `infra/.env` (copied from `infra/.env.example`):
`SHARED_SECRET`, `AUTH_SECRET`, `ADMIN_PASSWORD`, `POSTGRES_PASSWORD`,
`PUBLIC_WEB_URL`, `PUBLIC_PIPELINE_WS_URL`, `LLAMA_*`.

## llama-server

Gemma 4 E2B or E4B instruct GGUF plus the multimodal projector (`mmproj`) that
contains the audio encoder. `-hf` downloads both from Hugging Face on first
start into the `llama-cache` volume. `make model-pull` downloads the selected
model and BF16 projector into `infra/models/` and verifies their checksums;
run `make model-pull LLAMA_SERVICE=llama` on a CPU-only host to prepare the
Vulkan model for transfer. Compose continues to use `-hf`; an offline server
must be pointed at the downloaded files with `-m` and `--mmproj`.

```bash
llama-server -hf ggml-org/gemma-4-E2B-it-GGUF:Q8_0 \
  --host 0.0.0.0 --port 8080 \
  --parallel 4 -c 16384 -ngl 99 --jinja
```

- Keep the mmproj at BF16 (default with `-hf`); a quantized projector degrades
  the audio encoder noticeably for little memory gain.
- `--parallel` slots share `-c`. Each request needs roughly 400 tokens of
  context (prompt, audio, output), so 16384 leaves ample room for 4 slots.
- `--jinja` is required for the Gemma 4 chat template and `chat_template_kwargs`.
- The newer `llama` CLI (`curl -LsSf https://llama.app/install.sh | sh`) accepts
  the same idea: `llama serve -hf ggml-org/gemma-4-E2B-it-GGUF:Q8_0`.
- Test the setup without the pipeline: `scripts/transcribe-file.sh fixtures/audio/en-kubernetes-60s.wav`.

Docker with an AMD GPU through Vulkan:

```yaml
llama:
  image: ghcr.io/ggml-org/llama.cpp:server-vulkan
  command: >-
    -hf ${LLAMA_MODEL} --host 0.0.0.0 --port 8080
    --parallel ${LLAMA_PARALLEL} -c ${LLAMA_CTX} -ngl ${LLAMA_NGL} --jinja
  devices: ["/dev/dri:/dev/dri"]
  group_add: ["video", "render"]
  volumes: ["llama-cache:/root/.cache/llama.cpp"]
```

NVIDIA: image `server-cuda` and `deploy.resources.reservations.devices` with
the NVIDIA runtime. CPU only: image `server`, `-ngl 0`, `-t <physical cores>`.

## Hardware guidance

File sizes from the `ggml-org` repositories (September 2026):

| Model file | Size | With BF16 mmproj (0.99 GB) |
| --- | --- | --- |
| E2B Q4_0 | 2.84 GB | 3.8 GB |
| E2B Q8_0 | 4.97 GB | 6.0 GB |
| E4B Q4_0 | 4.59 GB | 5.6 GB |
| E4B Q8_0 | 8.03 GB | 9.0 GB |

Add about 0.5-1 GB for KV cache and compute buffers at `-c 16384`.

| Machine | Recommended | Expected |
| --- | --- | --- |
| Laptop, CPU only (dev) | `PROVIDER=mock`; or E2B Q4_0, `-ngl 0`, `--parallel 1` | 1 session near real time, 4-8 s per chunk |
| AMD RX 6600 8 GB (demo box) | E2B Q8_0 or E4B Q4_0, Vulkan, `--parallel 4` | 1-2 live sessions with p95 under 10 s |
| 24 GB NVIDIA | E4B Q8_0 with llama.cpp, or vLLM `google/gemma-4-E4B-it` | 5-10 sessions with vLLM batching |
| Several GPUs | One llama-server or vLLM per GPU, all in `INFERENCE_URLS` | Linear scaling per GPU |

Check the demo box before relying on it: `vulkaninfo --summary` lists the GPU
and its VRAM (`RX 6600` reports 8 GB; if the card reports 3 GB it is a
different model and only E2B Q4_0 with partial offload, `-ngl 20`, will fit).
ROCm on the RX 6600 (gfx1032) is not officially supported and needs
`HSA_OVERRIDE_GFX_VERSION=10.3.0`; Vulkan avoids that.

## Vibeathon demo topology

- GPU box: `docker compose -f infra/compose.yml --profile infra up llama`
  (or the native binary), reachable on the LAN as `http://gpu-box:8080`.
- Laptop: `make infra-up` for Postgres only (`docker compose ... up postgres`),
  `INFERENCE_URLS=http://gpu-box:8080 make pipeline`, `make web`.
- Second pipeline instance is unnecessary; one pipeline handles all sessions.
- For the parallel-sessions demo, seed `file_replay` sessions and run some of
  them on the mock provider by starting a second pipeline with `PROVIDER=mock`
  on another port and pointing selected sessions at it (backlog: per-session
  provider selection; for the demo, two pipelines with disjoint session sets).

## Event deployment checklist

1. Server with a GPU, Docker, and the venue network reaching it on 3000 and 8090
   (or behind a reverse proxy with WebSocket support for `/v1/sessions/*/ingest`).
2. `cp infra/.env.example infra/.env`, set secrets, `PUBLIC_WEB_URL`,
   `PUBLIC_PIPELINE_WS_URL` (must be `wss://` when the site is `https://`).
3. `make model-pull` while on good connectivity.
4. `docker compose -f infra/compose.yml --profile all up -d`, then
   `make db-push` once (or the `web` container runs migrations at start).
5. Log into `/admin`, create one session per stage, open the operator page on
   the laptop at each stage, start sessions.
6. Print `https://<host>/s/<slug>` as QR codes for the rooms.

## Operations notes

- Logs: `docker compose logs -f pipeline` shows one JSON line per chunk with
  latency; `llama` logs slot usage.
- Restarting the pipeline drops in-flight audio only; sessions must be
  restarted from the admin panel (they show `error` / `status_timeout`).
- Postgres volume `pgdata` holds all transcripts; back it up after the event.
