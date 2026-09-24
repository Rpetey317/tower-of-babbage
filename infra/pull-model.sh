#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

env_file="$repo_root/infra/.env"
if [[ ! -f "$env_file" ]]; then
  env_file="$repo_root/infra/.env.example"
fi

service="${LLAMA_SERVICE:-}"
if [[ -z "$service" ]]; then
  service=llama-cpu
  if [[ -e /dev/dri ]]; then
    service=llama
  fi
fi
case "$service" in
  llama|llama-cpu) ;;
  *) echo "Unsupported LLAMA_SERVICE: $service" >&2; exit 2 ;;
esac

model_ref="$(docker compose --env-file "$env_file" -f infra/compose.yml --profile infra --profile cpu config --format json |
  node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(0, "utf8"));
    const command = config.services[process.argv[1]].command;
    const index = command.indexOf("-hf");
    if (index < 0 || !command[index + 1]) throw new Error("Expected a Hugging Face model reference");
    process.stdout.write(command[index + 1]);
  ' "$service")"

if [[ ! "$model_ref" =~ ^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$ ]]; then
  echo "Model reference must use owner/repository:quantization: $model_ref" >&2
  exit 2
fi

model_repo="${model_ref%:*}"
quantization="${model_ref##*:}"
hf_endpoint="${HF_ENDPOINT:-https://huggingface.co}"
hf_endpoint="${hf_endpoint%/}"
model_dir="${MODEL_DIR:-$repo_root/infra/models}"

metadata="$(curl --fail --location --silent --show-error --retry 3 \
  "$hf_endpoint/api/models/$model_repo/tree/main?recursive=true")"
file_list="$(printf '%s' "$metadata" | node -e '
  const fs = require("node:fs");
  const files = JSON.parse(fs.readFileSync(0, "utf8"));
  const quantization = process.argv[1];
  const model = files.filter((file) =>
    file.path.endsWith(`-${quantization}.gguf`) &&
    !/^(mmproj|mtp)-/.test(file.path));
  const projector = files.filter((file) =>
    file.path.startsWith("mmproj-") && file.path.endsWith("-BF16.gguf"));
  if (model.length !== 1 || projector.length !== 1 ||
      !model[0].lfs?.oid || !projector[0].lfs?.oid) {
    throw new Error(`Expected one ${quantization} model and one BF16 projector`);
  }
  for (const file of [model[0], projector[0]]) {
    console.log(`${file.path}\t${file.lfs.oid}`);
  }
' "$quantization")"

mkdir -p "$model_dir"
while IFS=$'\t' read -r file_name checksum; do
  destination="$model_dir/$(basename "$file_name")"
  if [[ -f "$destination" ]] &&
     printf '%s  %s\n' "$checksum" "$destination" | sha256sum --check --status; then
    echo "Already verified: $destination"
    continue
  fi

  partial="$destination.part"
  echo "Downloading $file_name"
  curl --fail --location --show-error --retry 3 --continue-at - \
    --output "$partial" "$hf_endpoint/$model_repo/resolve/main/$file_name"
  printf '%s  %s\n' "$checksum" "$partial" | sha256sum --check --status || {
    echo "Checksum mismatch: $file_name" >&2
    rm -f "$partial"
    exit 1
  }
  mv "$partial" "$destination"
  echo "Verified: $destination"
done <<< "$file_list"
