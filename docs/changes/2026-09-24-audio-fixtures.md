# Audio fixtures (M0-07)

Added one-minute English and Argentinian Spanish speech fixtures for replay, with ground-truth scripts, ordered mock transcript lines, and voice and license provenance. Both WAV files use 16 kHz mono signed 16-bit PCM. Clarified that mock filenames use the replay file stem.

Verify with `ffprobe` on both WAV files; each must report `pcm_s16le`, 16,000 Hz, one channel, and a duration from 55 to 65 seconds. Run `make lint` and `make test`. A GPU is not needed for these fixtures; real Gemma transcription belongs to M0-08.
