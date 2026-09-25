# Deployment

How to run Tower of Babbage for development, for the Vibeathon demo and for a
conference. Topologies are described in [architecture.md](architecture.md);
every variable is listed in [stack.md](stack.md).

## Services (`infra/compose.yml`)

| Service | Image | Ports | Profile |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine`, volume `pgdata` | 5432 | `infra`, `all` |
| `llama` | `ghcr.io/ggml-org/llama.cpp:server-vulkan` (or `server-cuda`, `server` for CPU) | 8080 | `infra` |
| `llama-cpu` | `ghcr.io/ggml-org/llama.cpp:server` | 8080 | `cpu` |
| `pipeline` | built from `services/pipeline/Dockerfile` (Debian slim, includes ffmpeg) | 8090 | `all` |
| `web` | built from `apps/web/Dockerfile` (Next.js standalone output) | 3000 | `all` |

The `llama` and `llama-cpu` services are only needed for local inference; the
Gemini demo/MVP path needs only `postgres`.

`make infra-up` runs profile `infra` (development: web and pipeline run from
source). It selects the Vulkan service when `/dev/dri` exists and otherwise
uses the CPU service. Set `LLAMA_SERVICE=llama` or `LLAMA_SERVICE=llama-cpu`
to override detection. Both development ports bind to `127.0.0.1` by default;
set `LLAMA_BIND_HOST` to the GPU box's LAN address when another machine needs
to reach inference. Change `POSTGRES_BIND_HOST` only when remote database access
is required. Docker Desktop on WSL2 exposes AMD GPUs as `/dev/dxg`,
which the Vulkan image cannot use, so it selects CPU. The Docker Vulkan path
requires native Linux; on Windows use the native setup described below.
`docker compose -f infra/compose.yml --profile all up -d --wait` builds and
runs the full application stack for an event (Postgres, web, pipeline; add
`--profile infra` or `--profile cpu` when inference runs in the same stack).
The `web` container applies the Drizzle migrations before it starts serving.
`web` and `pipeline` publish on all interfaces (`WEB_BIND_HOST`,
`PIPELINE_BIND_HOST`) so the venue network can reach them; host ports are
`WEB_PORT`, `PIPELINE_PORT`, `POSTGRES_PORT`, `LLAMA_PORT`. Health checks:
`pg_isready`, `GET :8080/health`, `GET :8090/healthz`, `GET :3000/api/health`.

Secrets and hosts come from `infra/.env` (copied from `infra/.env.example`):
`SHARED_SECRET`, `AUTH_SECRET`, `ADMIN_PASSWORD`, `POSTGRES_PASSWORD`,
`PUBLIC_WEB_URL`, `PUBLIC_PIPELINE_WS_URL` (published to the browser as
`NEXT_PUBLIC_PIPELINE_WS_URL`; public variables are also build args because
Next.js inlines `NEXT_PUBLIC_*` in client bundles), `PROVIDER` (`mock`,
`gemini` or `openai-compat`), `GEMINI_API_KEY` (Gemini path),
`LLAMA_*` (local path).

The playback view (`/s/[slug]/play`) serves video fixtures through the web
app's `MEDIA_DIR` (default `../../fixtures/audio`); point it at the same
directory the pipeline sees as `FIXTURES_DIR`. See
[components/playback.md](components/playback.md).

## Local inference: llama-server

Only needed for the local path (`PROVIDER=openai-compat`); not for the Gemini
demo. Gemma 4 E2B or E4B instruct GGUF plus the multimodal projector (`mmproj`) that
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
- Test the setup without the pipeline: `scripts/transcribe-file.sh fixtures/audio/en-kubernetes-60s.wav`
  (`.\scripts\transcribe-file.ps1` on native Windows).

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

### Native Windows (RX 6600 over Vulkan)

Windows 10/11 x64 with Windows PowerShell 5.1+; no Docker, WSL or Node needed
for the inference-only path. Requirements:

- A current AMD Adrenalin driver on the demo box (it provides the Vulkan
  loader). Optional check: `vulkaninfo --summary` from the Vulkan SDK or
  driver package lists the GPU.
- A native `llama-server` Windows x64 Vulkan build from
  <https://github.com/ggml-org/llama.cpp/releases>. Pick a specific release
  whose assets include the Windows Vulkan build and whose notes mention
  Gemma 4 audio support; the `latest` alias can point at a nightly tag with no
  binaries, so choose the release explicitly. Extract `llama-server.exe` and
  its DLLs together into `bin\llama\` (`bin/` is git-ignored).
- `ffmpeg` and `curl.exe` 7.76+ on `PATH` (the scripts use
  `--fail-with-body`) — the real `curl.exe`, not the `curl` alias for
  `Invoke-WebRequest`.
- If PowerShell refuses to run the scripts, allow them for the current
  process only: `Set-ExecutionPolicy -Scope Process RemoteSigned`.

Day-to-day commands go through the `dev.ps1` task runner at the repo root:

```powershell
.\dev.ps1 model-pull     # download the configured model + BF16 projector into infra\models (SHA-256 verified)
.\dev.ps1 inference      # start llama-server in the foreground
```

`.\dev.ps1 help` lists every task and override; `.\dev.ps1 test-inference`
runs the offline Windows test suite. `model-pull` contacts Hugging Face only
while downloading; `inference` starts purely from local files and keeps the
server in the foreground — wait for its ready message, press Ctrl+C to stop.

From a second terminal, once the server is ready (`Invoke-RestMethod
http://127.0.0.1:8080/health` also works):

```powershell
.\dev.ps1 transcribe     # sends the first 10 s of the English fixture, en -> es
.\dev.ps1 transcribe -AudioFile fixtures/audio/es-charla-60s.wav -SourceLanguage es -TargetLanguage en
```

Startup settings come from the process environment and from the dotenv files
the scripts source through `infra\env.ps1` (copy `infra\.env.example` to
`infra\.env` — git-ignored — and edit it to customize). Precedence: process
`$env:` > `infra\.env` > `infra\.env.example` > built-in defaults.
Recognized keys:
`LLAMA_MODEL` (`owner/repo:quant`; the launcher picks the matching
`-<quant>.gguf` and `mmproj-*-BF16.gguf` in `MODEL_DIR`),
`MODEL_DIR`, `HF_ENDPOINT`, `LLAMA_SERVER_EXE` (explicit binary path,
preferred over `bin\llama` and `PATH`), `LLAMA_BIND_HOST`, `LLAMA_PORT`,
`LLAMA_PARALLEL`, `LLAMA_CTX`, `LLAMA_NGL`. Keep exactly one model family per
`MODEL_DIR`; the launcher fails on ambiguous candidates rather than guessing.
If `LLAMA_PORT` changes, set `INFERENCE_URLS` to match in the transcribe
terminal (`$env:INFERENCE_URLS = 'http://127.0.0.1:<port>'`). `transcribe`
also honors `INFERENCE_MODEL`, `INFERENCE_AUDIO_FORMAT` and
`INFERENCE_TEMPERATURE` like the Bash version. The underlying scripts
(`infra\pull-model.ps1`, `infra\start-inference.ps1`,
`scripts\transcribe-file.ps1`) can still be run directly.

The GPU acceptance run for issue #47 is still pending; record there: raw
`vulkaninfo --summary` output, VRAM from the full `vulkaninfo` memory-heap
section or another reliable GPU tool (not `Win32_VideoController`, whose
AdapterRAM field overflows past 4 GB), the chosen quantization, the
llama-server startup lines showing the Vulkan device and `-ngl` offload, and
the raw model response plus request time from `transcribe-file.ps1`.

## Hardware guidance

The Gemini path needs no GPU: any machine that reaches the API works. This
section applies to local inference only. File sizes from the `ggml-org`
repositories (September 2026):

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

Check the demo box before relying on it: `vulkaninfo --summary` identifies the
GPU and driver; the `memoryHeaps` `DEVICE_LOCAL` total in the full
`vulkaninfo` output reports usable VRAM (`RX 6600` has 8 GB; a card reporting
around 3 GB is a different model and only E2B Q4_0 with partial offload,
`-ngl 20`, will fit).
ROCm on the RX 6600 (gfx1032) is not officially supported and needs
`HSA_OVERRIDE_GFX_VERSION=10.3.0`; Vulkan avoids that.

## Vibeathon demo topology

The demo runs on the Gemini API: no GPU box, only outbound internet.

- Laptop: Postgres only (`docker compose -f infra/compose.yml up -d postgres`),
  `GEMINI_API_KEY=<key> PROVIDER=gemini make pipeline`, `make web`.
- Second pipeline instance is unnecessary; one pipeline handles all sessions.
- For the parallel-sessions demo, seed `file_replay` sessions and run some of
  them on the mock provider by starting a second pipeline with `PROVIDER=mock`
  on another port and pointing selected sessions at it (backlog: per-session
  provider selection; for the demo, two pipelines with disjoint session sets).

Local alternative (no Gemini access): a GPU box serves llama-server on the LAN
(`docker compose -f infra/compose.yml --profile infra up llama`, reachable as
`http://gpu-box:8080`) and the laptop runs
`INFERENCE_URLS=http://gpu-box:8080 PROVIDER=openai-compat make pipeline`.

## Event deployment checklist

1. Server with Docker, outbound internet to the Gemini API (or a GPU for the
   local path), and the venue network reaching it on 3000 and 8090
   (or behind a reverse proxy with WebSocket support for `/v1/sessions/*/ingest`).
2. `cp infra/.env.example infra/.env`, set secrets, `PUBLIC_WEB_URL`,
   `PUBLIC_PIPELINE_WS_URL` (must be `wss://` when the site is `https://`),
   `PROVIDER=gemini` and `GEMINI_API_KEY`.
3. Local path only: `make model-pull` while on good connectivity and deploy
   with `PROVIDER=openai-compat`.
4. `docker compose -f infra/compose.yml --profile all up -d --wait` (the `web`
   container applies the migrations itself before serving; for local
   inference add `--profile infra` or `--profile cpu`).
5. Log into `/admin`, create one session per stage, open the operator page on
   the laptop at each stage, start sessions.
6. Print `https://<host>/s/<slug>` as QR codes for the rooms.

## Operations notes

- Logs: `docker compose logs -f pipeline` shows one JSON line per chunk with
  latency; on the local path, `llama` logs slot usage.
- Restarting the pipeline drops in-flight audio only; sessions must be
  restarted from the admin panel (they show `error` / `status_timeout`).
- Postgres volume `pgdata` holds all transcripts; back it up after the event.
