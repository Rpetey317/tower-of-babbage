package provider

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

var _ SpeechProvider = (*Mock)(nil)

// Mock is a deterministic SpeechProvider used by `make smoke`, UI development
// and multi-session load tests. It answers after a fixed latency with canned
// text, or with successive lines of a `<replay stem>.mock.txt` file when one
// is loaded for a file_replay source.
type Mock struct {
	latency time.Duration
	lines   []string
	next    atomic.Int64
}

// NewMock returns a provider that sleeps latency before every call and cycles
// through lines as transcripts; an empty list yields the default canned text.
func NewMock(latency time.Duration, lines []string) *Mock {
	return &Mock{latency: latency, lines: lines}
}

// LoadMockLines reads a `.mock.txt` file into non-empty trimmed lines.
func LoadMockLines(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read mock lines: %w", err)
	}
	var lines []string
	for _, line := range strings.Split(string(data), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	return lines, nil
}

func (m *Mock) Transcribe(ctx context.Context, audio WAV, req TranscribeRequest) (Transcript, error) {
	if err := m.wait(ctx); err != nil {
		return Transcript{}, err
	}
	if line := m.nextLine(); line != "" {
		return Transcript{Text: line, Speaker: speakerFor(audio)}, nil
	}
	return Transcript{Text: canned(req.SourceLanguage, "chunk", audio), Speaker: speakerFor(audio)}, nil
}

func (m *Mock) TranscribeAndTranslate(ctx context.Context, audio WAV, req ASTRequest) (ASTResult, bool, error) {
	if err := m.wait(ctx); err != nil {
		return ASTResult{}, false, err
	}
	transcript := m.nextLine()
	if transcript == "" {
		transcript = canned(req.SourceLanguage, "chunk", audio)
	}
	return ASTResult{
		Transcript:  Transcript{Text: transcript, Speaker: speakerFor(audio)},
		Translation: canned(req.TargetLanguage, "fragmento", audio),
	}, true, nil
}

func (m *Mock) Translate(ctx context.Context, text string, req TranslateRequest) (string, error) {
	if err := m.wait(ctx); err != nil {
		return "", err
	}
	return fmt.Sprintf("[mock %s] %s", req.TargetLanguage, text), nil
}

func (m *Mock) Healthy() bool {
	return true
}

// nextLine consumes mock.txt lines in order and wraps around so `loop` replays
// stay deterministic.
func (m *Mock) nextLine() string {
	if len(m.lines) == 0 {
		return ""
	}
	return m.lines[int(m.next.Add(1)-1)%len(m.lines)]
}

func (m *Mock) wait(ctx context.Context) error {
	if m.latency <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(m.latency)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// speakerFor attributes chunks to speakers deterministically — two chunks
// per label alternating S1/S2 — so UI work can exercise speaker colors.
func speakerFor(audio WAV) string {
	return fmt.Sprintf("S%d", audio.Index/2%2+1)
}

func canned(language, noun string, audio WAV) string {
	return fmt.Sprintf("[mock %s] %s %d, %.1fs-%.1fs",
		language, noun, audio.Index, float64(audio.StartMs)/1000, float64(audio.EndMs)/1000)
}
