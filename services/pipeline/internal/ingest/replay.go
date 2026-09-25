package ingest

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/chunk"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
)

// frameBytes is the ingest frame size from docs/components/ingest.md:
// 200 ms of mono 16 kHz s16le audio, 6400 bytes.
const frameBytes = 6400

// stderrLimit bounds the ffmpeg error output kept for diagnostics.
const stderrLimit = 4096

// ExitedError means the producer process ended while its run was still
// active — a decode failure or the natural end of a non-looping file. The
// caller reports it as an ffmpeg_exit log event (contract section 6).
type ExitedError struct {
	ExitCode int
	Stderr   string
}

func (e *ExitedError) Error() string {
	if e.ExitCode == 0 {
		return "ffmpeg reached end of file"
	}
	return fmt.Sprintf("ffmpeg exited with code %d", e.ExitCode)
}

// Replay is the file_replay source: ffmpeg paced at real time decoding a file
// under FIXTURES_DIR into the session's PCM frame stream. Each session runs at
// most one Replay; cancelling ctx is the only graceful stop.
type Replay struct {
	path   string // resolved path under dir
	loop   bool
	pace   bool // -re realtime pacing; tests disable it
	ffmpeg string
}

// NewReplay validates cfg under dir and returns a ready-to-run source. Only
// paths local to dir are accepted: absolute paths, parent traversal and
// anything pointing outside are rejected (docs/components/ingest.md).
func NewReplay(dir string, cfg contract.FileReplayConfig) (*Replay, error) {
	if !filepath.IsLocal(cfg.Path) {
		return nil, fmt.Errorf("invalid_source: path %q must be relative to FIXTURES_DIR", cfg.Path)
	}
	path := filepath.Join(dir, cfg.Path)
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("invalid_source: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("invalid_source: %q is not a regular file", cfg.Path)
	}
	return &Replay{path: path, loop: cfg.Loop, pace: true, ffmpeg: "ffmpeg"}, nil
}

// Run streams the file into sink until ffmpeg exits or ctx is cancelled. It
// returns nil when cancelled by the caller, and *ExitedError when ffmpeg ends
// on its own while the run is still active.
func (r *Replay) Run(ctx context.Context, sink Sink) error {
	args := []string{"-hide_banner", "-loglevel", "error"}
	if r.pace {
		args = append(args, "-re")
	}
	if r.loop {
		args = append(args, "-stream_loop", "-1")
	}
	args = append(args, "-i", r.path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-")

	cmd := exec.CommandContext(ctx, r.ffmpeg, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("ffmpeg stdout: %w", err)
	}
	stderr := &limitedBuffer{limit: stderrLimit}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("ffmpeg start: %w", err)
	}

	var clock chunk.Clock
	buf := make([]byte, frameBytes)
	readErr := func() error {
		for {
			n, err := io.ReadFull(stdout, buf)
			if n > 0 {
				frame := make([]byte, n)
				copy(frame, buf[:n])
				sink.Push(clock.NextFrame(frame))
			}
			if err != nil {
				return err
			}
		}
	}()
	waitErr := cmd.Wait()

	if ctx.Err() != nil {
		return nil // cancelled by the session's stop
	}
	if errors.Is(readErr, io.ErrClosedPipe) {
		readErr = io.EOF
	}
	switch {
	case waitErr != nil:
		code := -1
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			code = exitErr.ExitCode()
		}
		return &ExitedError{ExitCode: code, Stderr: stderr.String()}
	case errors.Is(readErr, io.EOF), errors.Is(readErr, io.ErrUnexpectedEOF):
		return &ExitedError{ExitCode: 0}
	case readErr != nil:
		return fmt.Errorf("ffmpeg stdout: %w", readErr)
	}
	return &ExitedError{ExitCode: 0}
}

// limitedBuffer keeps at most limit bytes of stderr for error reporting.
type limitedBuffer struct {
	buf   []byte
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.limit - len(b.buf); room > 0 {
		b.buf = append(b.buf, p[:min(room, len(p))]...)
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string { return string(b.buf) }
