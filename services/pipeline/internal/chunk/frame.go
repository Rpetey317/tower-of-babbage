// Package chunk turns the ingest frame stream into model-sized audio chunks:
// PCM frames stamped with audio time, an energy VAD with an adaptive noise
// floor, and the cut rules from docs/components/ingest.md.
package chunk

const (
	// SampleRate is the normalized ingest rate: mono 16 kHz s16le.
	SampleRate = 16000

	bytesPerSecond = SampleRate * 2
	bytesPerMs     = bytesPerSecond / 1000
)

// Frame is one producer-delivered PCM buffer: mono 16 kHz signed 16-bit
// little-endian samples, stamped with the audio position of its first sample.
type Frame struct {
	StartMs int64
	PCM     []byte
}

// Clock converts a running sample count into audio-millisecond positions, so
// frame timestamps are exact audio positions since the run started,
// independent of network jitter or processing delay.
type Clock struct {
	samples int64
}

// Advance stamps count upcoming samples and moves the clock past them,
// returning the start and end positions in audio milliseconds.
func (c *Clock) Advance(samples int64) (startMs, endMs int64) {
	start := c.samples
	c.samples += samples
	return start * 1000 / SampleRate, c.samples * 1000 / SampleRate
}

// NextFrame stamps pcm with the audio position of its first sample and
// advances the clock past it.
func (c *Clock) NextFrame(pcm []byte) Frame {
	start, _ := c.Advance(int64(len(pcm)) / 2)
	return Frame{StartMs: start, PCM: pcm}
}

// ReceivedMs is the audio time received so far: audioReceivedMs.
func (c *Clock) ReceivedMs() int64 {
	return c.samples * 1000 / SampleRate
}
