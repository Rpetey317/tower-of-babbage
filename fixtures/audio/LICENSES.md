# Audio fixture licenses and provenance

The scripts (`.txt`) and mock transcripts (`.mock.txt`) were written for this project and are covered by the repository's [Apache 2.0 license](../../LICENSE). The WAV files are synthesized readings of those scripts and are distributed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

| WAV file | Piper voice (release `v1.0.0`) | Voice training data and attribution |
| --- | --- | --- |
| `en-kubernetes-60s.wav` | [`en_US-ljspeech-medium`](https://huggingface.co/rhasspy/piper-voices/tree/v1.0.0/en/en_US/ljspeech/medium) | [LJ Speech](https://keithito.com/LJ-Speech-Dataset/), public domain; voice model trained by Bryce Beattie according to its model card. |
| `en-glossary-30s.wav` | [`en_US-ljspeech-medium`](https://huggingface.co/rhasspy/piper-voices/tree/v1.0.0/en/en_US/ljspeech/medium) | Same as `en-kubernetes-60s.wav` above. |
| `es-charla-60s.wav` | [`es_AR-daniela-high`](https://huggingface.co/rhasspy/piper-voices/tree/v1.0.0/es/es_AR/daniela/high) | [OpenSLR SLR61](https://www.openslr.org/61/) Argentinian Spanish recordings, CC BY-SA 4.0, copyright 2018–2019 Google Inc.; voice model trained by [larcanio](https://huggingface.co/larcanio/piper-voices) according to its model card. |
| `pt-sample-30s.wav` | [`pt_BR-faber-medium`](https://huggingface.co/rhasspy/piper-voices/tree/v1.0.0/pt/pt_BR/faber/medium) | [NabuCasa voice-datasets](https://github.com/NabuCasa/voice-datasets), CC0; voice model finetuned from the U.S. English lessac voice (medium) according to its model card. |

The [Piper voice collection](https://huggingface.co/rhasspy/piper-voices) is MIT licensed. Audio was generated with Piper `1.8.0` on CPU using `--sentence-silence 0.25`, then converted from 22,050 Hz to mono 16 kHz signed 16-bit PCM with FFmpeg. No source recordings or model weights are included here. To regenerate a fixture after downloading its voice model and matching `.onnx.json` file, run:

```sh
python -m piper -m <voice>.onnx -i <name>.txt -f <name>-raw.wav --sentence-silence 0.25
ffmpeg -i <name>-raw.wav -ar 16000 -ac 1 -c:a pcm_s16le -map_metadata -1 -bitexact <name>.wav
```
