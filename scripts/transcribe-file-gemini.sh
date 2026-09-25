#!/usr/bin/env bash
# Gemini variant of transcribe-file.sh: sends the first 10 seconds of a WAV to
# the Gemini generateContent endpoint and prints the raw output, transcript
# and translation. Requires GEMINI_API_KEY; GEMINI_MODEL defaults to
# gemini-3.8-flash.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo "Usage: $0 <wav> [source language: en|es|pt] [target language: en|es|pt]" >&2
  exit 2
fi

audio_file="$1"
if [[ ! -f "$audio_file" ]]; then
  echo "Audio file not found: $audio_file" >&2
  exit 2
fi
if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "GEMINI_API_KEY is required (Google AI Studio key)" >&2
  exit 2
fi

language_name() {
  case "$1" in
    en) echo English ;;
    es) echo Spanish ;;
    pt) echo Portuguese ;;
    *) echo "Unsupported language: $1 (use en, es, or pt)" >&2; return 2 ;;
  esac
}

source_name="$(language_name "${2:-en}")"
target_name="$(language_name "${3:-es}")"
if [[ "$source_name" == "$target_name" ]]; then
  echo "Source and target languages must differ" >&2
  exit 2
fi

base_url="${GEMINI_BASE_URL:-https://generativelanguage.googleapis.com}"
base_url="${base_url%/}"
model="${GEMINI_MODEL:-gemini-3.8-flash}"
endpoint="${base_url}/v1beta/models/${model}:generateContent"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

# Ten seconds is a representative first chunk and keeps this check quick.
ffmpeg -v error -nostdin -i "$audio_file" -t 10 -ar 16000 -ac 1 -c:a pcm_s16le \
  -y "$work_dir/chunk.wav"
base64 < "$work_dir/chunk.wav" | tr -d '\n' > "$work_dir/chunk.b64"

prompt="Transcribe the following speech segment in ${source_name}, then translate it into ${target_name}.
When formatting the answer, first output the transcription in ${source_name}, then one newline, then output the string '${target_name}: ', then the translation in ${target_name}."

node -e '
  const fs = require("node:fs");
  const temperature = Number(process.argv[4]);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error("INFERENCE_TEMPERATURE must be a number from 0 to 2");
  }
  const audioData = fs.readFileSync(process.argv[1], "utf8");
  const request = {
    contents: [{parts: [
      {inlineData: {mimeType: "audio/wav", data: audioData}},
      {text: process.argv[2]}
    ]}],
    generationConfig: {temperature, maxOutputTokens: 256}
  };
  process.stdout.write(JSON.stringify(request));
' "$work_dir/chunk.b64" "$prompt" "$model" \
  "${INFERENCE_TEMPERATURE:-0.2}" > "$work_dir/request.json"

if ! request_time="$(curl --fail-with-body --silent --show-error --max-time 180 \
  --header 'Content-Type: application/json' \
  --header "x-goog-api-key: $GEMINI_API_KEY" \
  --data-binary "@$work_dir/request.json" \
  --output "$work_dir/response.json" \
  --write-out '%{time_total}' \
  "$endpoint")"; then
  echo "Inference request failed at $endpoint" >&2
  if [[ -s "$work_dir/response.json" ]]; then
    node -e '
      const fs = require("node:fs");
      const body = fs.readFileSync(process.argv[1], "utf8");
      try {
        const error = JSON.parse(body).error;
        console.error(typeof error === "string" ? error : error?.message ?? body);
      } catch {
        console.error(body);
      }
    ' "$work_dir/response.json"
  fi
  exit 1
fi

node -e '
  const fs = require("node:fs");
  try {
    const response = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const candidate = response.candidates?.[0];
    if (!candidate) {
      const block = response.promptFeedback?.blockReason;
      throw new Error(block ? `Prompt blocked: ${block}` : "Response has no candidates");
    }
    if (candidate.finishReason === "MAX_TOKENS") {
      throw new Error("Model output was truncated (finishReason: MAX_TOKENS)");
    }
    const raw = (candidate.content?.parts ?? []).map((part) => part.text ?? "").join("");
    if (!raw.trim()) {
      throw new Error("Model response has no text content");
    }
    console.log(`Raw model output:\n${raw}`);
    const lines = raw.split(/\r?\n/);
    const marker = `${process.argv[2]}:`;
    const markerLine = lines.findIndex((line) => line.trimStart().startsWith(marker));
    if (markerLine < 0) throw new Error(`Model output has no ${marker} line`);
    const normalize = (text) => text.replace(/\s+/g, " ").trim();
    const transcript = normalize(lines.slice(0, markerLine).join(" "));
    const markerText = lines[markerLine].trimStart().slice(marker.length);
    const translation = normalize([markerText, ...lines.slice(markerLine + 1)].join(" "));
    if (!transcript || !translation) throw new Error("Model output is missing transcript or translation");
    console.log(`\nTranscript: ${transcript}`);
    console.log(`${process.argv[2]}: ${translation}`);
  } catch (error) {
    console.error(`Invalid model response: ${error.message}`);
    process.exitCode = 1;
  }
' "$work_dir/response.json" "$target_name"
printf 'Request time: %ss\n' "$request_time"
