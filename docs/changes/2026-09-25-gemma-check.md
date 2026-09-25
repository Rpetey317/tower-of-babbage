# Gemma 4 model check (M0-08)

Added `scripts/transcribe-file.sh` to send the first 10 seconds of a WAV to the
configured llama-server endpoint using the Gemma 4 AST prompt. It prints the
raw response, parsed transcript and translation, and request time. The existing
`infra/pull-model.sh` downloads and verifies the selected GGUF and BF16 audio
projector.

The Vulkan run on the demo box remains to be done. On that machine, run:

```bash
vulkaninfo --summary
make model-pull LLAMA_SERVICE=llama
make infra-up LLAMA_SERVICE=llama
scripts/transcribe-file.sh fixtures/audio/en-kubernetes-60s.wav
```

Record VRAM, the selected quantization, raw fixture output, and request time in
issue #8. Mark M0-08 done after the real model prints English and Spanish text.
