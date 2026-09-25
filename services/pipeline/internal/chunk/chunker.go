package chunk

import "time"

const (
	// WindowMs is the VAD analysis window: 20 ms, 320 samples, 640 bytes.
	WindowMs       = 20
	windowBytes    = SampleRate * WindowMs / 1000 * 2
	pauseCutMs     = 250  // first pause of this length cuts once Target is buffered
	longPauseCutMs = 1500 // pause of this length cuts immediately once Min is buffered
	lastSecondMs   = 1000 // max cut searches this trailing span for the lowest energy
	// speechRatioMin discards chunks with less speech (no model call); the
	// clock still advances so timestamps stay correct.
	speechRatioMin = 0.05
)

// Config carries the chunker's length tunables; CHUNK_*_SECONDS from the
// pipeline config map onto it.
type Config struct {
	Min    time.Duration // never cut before this much audio is buffered
	Target time.Duration // after this, cut at the first pause of >= 250 ms
	Max    time.Duration // hard cut at the lowest-energy window of the last second
}

// DefaultConfig returns the defaults from docs/components/ingest.md.
func DefaultConfig() Config {
	return Config{Min: 2 * time.Second, Target: 6 * time.Second, Max: 15 * time.Second}
}

// Chunk is one unit of audio for the provider: PCM plus its exact position in
// the run. Index is sequential among emitted (non-discarded) chunks.
type Chunk struct {
	Index   int
	StartMs int64
	EndMs   int64
	PCM     []byte
}

// WAV returns the chunk serialized for the provider.
func (c Chunk) WAV() []byte {
	return EncodeWAV(c.PCM)
}

type window struct {
	rms    float64
	speech bool
}

// Chunker buffers frames and emits chunks under the cut rules from
// docs/components/ingest.md: no cuts before Min, a >= 1.5 s pause cuts at its
// start, after Target any >= 250 ms pause cuts, and at Max the chunk is cut at
// the lowest-energy window of the last second. Producers are expected to send
// frames well below the pause thresholds (200 ms in ingest), so rules are
// evaluated once per pushed frame.
type Chunker struct {
	cfg     Config
	vad     *VAD
	pending []byte // received bytes not yet covering a full window
	pcm     []byte // window-aligned PCM of the current chunk
	windows []window
	startMs int64 // audio position of the current chunk start
	next    int
}

// New returns a Chunker with the default VAD.
func New(cfg Config) *Chunker {
	return NewWithVAD(cfg, NewVAD())
}

// NewWithVAD returns a Chunker with a caller-supplied VAD.
func NewWithVAD(cfg Config, vad *VAD) *Chunker {
	return &Chunker{cfg: cfg, vad: vad}
}

// Push appends a frame and applies the cut rules, returning the chunk when one
// completes. Chunks below the minimum speech ratio are discarded inside and
// not returned.
func (c *Chunker) Push(frame Frame) (Chunk, bool) {
	c.pending = append(c.pending, frame.PCM...)
	for len(c.pending) >= windowBytes {
		buf := c.pending[:windowBytes]
		c.pending = c.pending[windowBytes:]
		c.windows = append(c.windows, window{rms: rmsOf(buf), speech: c.vad.Speech(buf)})
		c.pcm = append(c.pcm, buf...)
	}
	return c.evaluate()
}

// Flush emits the buffered tail at stop or end-of-input when it meets the
// minimum length (docs/components/ingest.md rule 4).
func (c *Chunker) Flush() (Chunk, bool) {
	durMs := int64(len(c.pcm)+len(c.pending)) / bytesPerMs
	if durMs < c.cfg.Min.Milliseconds() {
		return Chunk{}, false
	}
	speechOK := c.speechOK(len(c.windows))
	pcm := append(c.pcm, c.pending...)
	c.pcm, c.pending, c.windows = nil, nil, nil
	return c.finish(pcm, durMs, speechOK)
}

// evaluate applies the cut rules once per pushed frame. A trailing silence run
// is measured in whole windows; the run start is the cut boundary, so emitted
// chunks end where the pause begins.
func (c *Chunker) evaluate() (Chunk, bool) {
	bufferedMs := int64(len(c.windows)) * WindowMs
	if bufferedMs >= c.cfg.Max.Milliseconds() {
		return c.cut(c.maxCutMs())
	}
	runMs := c.trailingSilenceMs()
	if runMs == 0 {
		return Chunk{}, false
	}
	runStartMs := bufferedMs - runMs
	if runStartMs == 0 || bufferedMs < c.cfg.Min.Milliseconds() {
		return Chunk{}, false // all-silence buffer or still below the minimum
	}
	if runMs >= longPauseCutMs {
		return c.cut(runStartMs)
	}
	if bufferedMs >= c.cfg.Target.Milliseconds() && runMs >= pauseCutMs {
		return c.cut(runStartMs)
	}
	return Chunk{}, false
}

// trailingSilenceMs is the duration of the silence run touching the buffer end.
func (c *Chunker) trailingSilenceMs() int64 {
	var run int64
	for i := len(c.windows) - 1; i >= 0 && !c.windows[i].speech; i-- {
		run++
	}
	return run * WindowMs
}

// maxCutMs picks the lowest-energy window within the last buffered second and
// cuts at its end; ties take the latest window, so uniform energy cuts exactly
// at Max.
func (c *Chunker) maxCutMs() int64 {
	n := int64(len(c.windows))
	first := n - lastSecondMs/WindowMs
	if first < 0 {
		first = 0
	}
	best := first
	for i := first; i < n; i++ {
		if c.windows[i].rms <= c.windows[best].rms {
			best = i
		}
	}
	return (best + 1) * WindowMs
}

// cut emits the chunk ending at relMs within the buffer and keeps the
// remainder (the pause or the audio after the max-cut window) for the next
// chunk.
func (c *Chunker) cut(relMs int64) (Chunk, bool) {
	nWin := relMs / WindowMs
	speechOK := c.speechOK(int(nWin))
	pcm := c.pcm[:nWin*windowBytes]
	c.pcm = append([]byte(nil), c.pcm[nWin*windowBytes:]...)
	c.windows = append([]window(nil), c.windows[nWin:]...)
	return c.finish(pcm, relMs, speechOK)
}

// finish stamps the emitted chunk, advances the audio position and returns the
// chunk only when it carries enough speech; the clock still advances on
// discarded chunks so timestamps stay correct.
func (c *Chunker) finish(pcm []byte, durMs int64, speechOK bool) (Chunk, bool) {
	ch := Chunk{Index: c.next, StartMs: c.startMs, EndMs: c.startMs + durMs, PCM: pcm}
	c.startMs += durMs
	if !speechOK {
		return Chunk{}, false
	}
	c.next++
	return ch, true
}

// speechOK reports whether the first n windows hold enough speech for a model
// call.
func (c *Chunker) speechOK(n int) bool {
	if n == 0 {
		return false
	}
	speech := 0
	for _, w := range c.windows[:n] {
		if w.speech {
			speech++
		}
	}
	return float64(speech)/float64(n) >= speechRatioMin
}
