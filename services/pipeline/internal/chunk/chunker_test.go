package chunk

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// feed pushes pcm through the chunker in 200 ms frames (the ingest frame size)
// and returns every emitted chunk, including a final Flush.
func feed(c *Chunker, pcm []byte) []Chunk {
	var clock Clock
	var chunks []Chunk
	const frameBytes = frameMs * bytesPerMs
	for len(pcm) > 0 {
		n := min(frameBytes, len(pcm))
		if ch, ok := c.Push(clock.NextFrame(pcm[:n])); ok {
			chunks = append(chunks, ch)
		}
		pcm = pcm[n:]
	}
	if ch, ok := c.Flush(); ok {
		chunks = append(chunks, ch)
	}
	return chunks
}

const frameMs = 200

func tonePCM(ms int, amplitude float64) []byte {
	pcm := make([]byte, ms*bytesPerMs)
	for i := 0; i < len(pcm)/2; i++ {
		sample := int16(amplitude * math.Sin(2*math.Pi*440*float64(i)/SampleRate))
		binary.LittleEndian.PutUint16(pcm[i*2:], uint16(sample))
	}
	return pcm
}

func silencePCM(ms int) []byte {
	return make([]byte, ms*bytesPerMs)
}

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

func TestCutsInsideSilences(t *testing.T) {
	signal := concat(
		tonePCM(5000, 8000),
		silencePCM(500),  // pause below Target: must not cut
		tonePCM(4000, 8000),
		silencePCM(2000), // long pause after Target: cut lands here
		tonePCM(3000, 8000),
	)
	chunks := feed(New(DefaultConfig()), signal)
	if len(chunks) != 2 {
		t.Fatalf("expected 2 chunks, got %d: %+v", len(chunks), chunks)
	}
	if chunks[0].EndMs < 9500 || chunks[0].EndMs > 11500 {
		t.Fatalf("chunk 0 ended at %d, outside the 9.5-11.5 s pause", chunks[0].EndMs)
	}
	if chunks[1].StartMs != chunks[0].EndMs || chunks[1].EndMs != 14500 {
		t.Fatalf("unexpected chunk 1 span: %d-%d", chunks[1].StartMs, chunks[1].EndMs)
	}
	for i, ch := range chunks {
		if ch.Index != i {
			t.Fatalf("chunk %d has index %d", i, ch.Index)
		}
		if int64(len(ch.PCM)) != (ch.EndMs-ch.StartMs)*bytesPerMs {
			t.Fatalf("chunk %d PCM length does not match its span", i)
		}
	}
}

func TestLongPauseCutsImmediately(t *testing.T) {
	// A >= 1.5 s pause cuts even when the buffer is below Target.
	signal := concat(tonePCM(3000, 8000), silencePCM(1600), tonePCM(3000, 8000))
	chunks := feed(New(DefaultConfig()), signal)
	if len(chunks) != 2 {
		t.Fatalf("expected 2 chunks, got %d", len(chunks))
	}
	if chunks[0].EndMs != 3000 {
		t.Fatalf("chunk 0 ended at %d, expected 3000 (pause start)", chunks[0].EndMs)
	}
}

func TestNoCutBeforeMin(t *testing.T) {
	// A short pause before Min is buffered stays inside the chunk.
	signal := concat(tonePCM(1500, 8000), silencePCM(400), tonePCM(4500, 8000))
	chunks := feed(New(DefaultConfig()), signal)
	if len(chunks) != 1 {
		t.Fatalf("expected 1 chunk, got %d", len(chunks))
	}
	if chunks[0].EndMs != 6400 {
		t.Fatalf("chunk ended at %d, expected 6400", chunks[0].EndMs)
	}
}

func TestHardCutAtMax(t *testing.T) {
	cfg := DefaultConfig()
	maxMs := cfg.Max.Milliseconds()
	// Constant energy: no dips anywhere, so the lowest-energy window of the
	// last second is its last one and the cut lands exactly at Max.
	signal := dcPCM(int(2*maxMs+2000), 8000)
	chunks := feed(New(cfg), signal)
	if len(chunks) != 3 {
		t.Fatalf("expected 3 chunks, got %d", len(chunks))
	}
	if chunks[0].EndMs != maxMs || chunks[1].EndMs != 2*maxMs {
		t.Fatalf("expected cuts at %d and %d, got %d and %d",
			maxMs, 2*maxMs, chunks[0].EndMs, chunks[1].EndMs)
	}
	if chunks[2].StartMs != 2*maxMs || chunks[2].EndMs != 2*maxMs+2000 {
		t.Fatalf("unexpected tail chunk: %d-%d", chunks[2].StartMs, chunks[2].EndMs)
	}
}

func TestSilentChunksDiscarded(t *testing.T) {
	signal := concat(silencePCM(20000), tonePCM(4000, 8000))
	chunks := feed(New(DefaultConfig()), signal)
	if len(chunks) != 1 {
		t.Fatalf("expected 1 chunk, got %d", len(chunks))
	}
	// The 15 s silence chunk was discarded without a model call, but the
	// audio clock still advanced: the first emitted chunk starts at 15 s
	// (the leftover silence stays buffered ahead of the tone).
	if chunks[0].StartMs != 15000 || chunks[0].Index != 0 {
		t.Fatalf("unexpected chunk span/index: %d-%d #%d",
			chunks[0].StartMs, chunks[0].EndMs, chunks[0].Index)
	}
}

func TestShortFlushDiscarded(t *testing.T) {
	// Tail below Min at stop is dropped.
	chunks := feed(New(DefaultConfig()), concat(tonePCM(1500, 8000), silencePCM(200)))
	if len(chunks) != 0 {
		t.Fatalf("expected no chunks, got %d", len(chunks))
	}
}

// readWAVPCM extracts the data chunk of a PCM WAV file.
func readWAVPCM(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("fixture not available: %v", err)
	}
	for pos := 12; pos+8 <= len(data); {
		size := int(binary.LittleEndian.Uint32(data[pos+4:]))
		if string(data[pos:pos+4]) == "data" {
			end := min(pos+8+size, len(data))
			return data[pos+8 : end]
		}
		pos += 8 + size + size%2
	}
	t.Fatalf("no data chunk in %s", path)
	return nil
}

func TestReplayFixtureGolden(t *testing.T) {
	pcm := readWAVPCM(t, filepath.Join("..", "..", "..", "..", "fixtures", "audio", "en-kubernetes-60s.wav"))
	chunks := feed(New(DefaultConfig()), pcm)
	const goldenChunks = 7
	if len(chunks) != goldenChunks {
		t.Fatalf("golden chunk count: expected %d, got %d", goldenChunks, len(chunks))
	}
	fileMs := int64(len(pcm)) / bytesPerMs
	if last := chunks[len(chunks)-1].EndMs; fileMs-last < 0 || fileMs-last > DefaultConfig().Min.Milliseconds()+frameMs {
		t.Fatalf("chunks end at %d, file is %d ms", last, fileMs)
	}
	var prevEnd int64
	for i, ch := range chunks {
		if ch.Index != i || ch.StartMs < prevEnd || ch.StartMs >= ch.EndMs {
			t.Fatalf("bad chunk ordering at %d: %+v", i, ch)
		}
		prevEnd = ch.EndMs
		if ch.EndMs-ch.StartMs > 30_000 {
			t.Fatalf("chunk %d exceeds the 30 s hard limit: %+v", i, ch)
		}
	}
}

func TestClockStampsAudioTime(t *testing.T) {
	var clock Clock
	frame := clock.NextFrame(make([]byte, 6400)) // 200 ms
	if frame.StartMs != 0 || clock.ReceivedMs() != 200 {
		t.Fatalf("unexpected clock state: %d %d", frame.StartMs, clock.ReceivedMs())
	}
	clock.NextFrame(make([]byte, 3200))
	if clock.ReceivedMs() != 300 {
		t.Fatalf("expected 300 ms received, got %d", clock.ReceivedMs())
	}
	start, end := clock.Advance(SampleRate) // 1 s
	if start != 300 || end != 1300 {
		t.Fatalf("unexpected advance: %d-%d", start, end)
	}
}

func TestNonFrameAlignedInput(t *testing.T) {
	// The chunker must handle arbitrary frame sizes, not just 200 ms.
	c := New(Config{Min: time.Second, Target: 3 * time.Second, Max: 10 * time.Second})
	signal := concat(tonePCM(4000, 8000), silencePCM(2000), tonePCM(2000, 8000))
	var clock Clock
	var chunks []Chunk
	sizes := []int{1000, 3333, 6400, 500} // odd frame boundaries
	for i := 0; len(signal) > 0; i++ {
		n := min(sizes[i%len(sizes)], len(signal))
		if ch, ok := c.Push(clock.NextFrame(signal[:n])); ok {
			chunks = append(chunks, ch)
		}
		signal = signal[n:]
	}
	if ch, ok := c.Flush(); ok {
		chunks = append(chunks, ch)
	}
	if len(chunks) != 2 {
		t.Fatalf("expected 2 chunks, got %d", len(chunks))
	}
	if chunks[0].EndMs != 4000 {
		t.Fatalf("chunk 0 ended at %d, expected 4000", chunks[0].EndMs)
	}
	if chunks[1].EndMs != 8000 {
		t.Fatalf("chunk 1 ended at %d, expected 8000", chunks[1].EndMs)
	}
}
