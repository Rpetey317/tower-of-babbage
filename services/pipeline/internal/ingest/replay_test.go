package ingest

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
)

var fixturesDir = filepath.Join("..", "..", "..", "..", "fixtures", "audio")

func requireFFmpeg(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
}

// wavDataBytes returns the length of the data chunk of a PCM WAV file, which
// at 16 kHz mono s16le converts to milliseconds by dividing by 32.
func wavDataBytes(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("fixture not available: %v", err)
	}
	for pos := 12; pos+8 <= len(data); {
		size := int(binary.LittleEndian.Uint32(data[pos+4:]))
		if string(data[pos:pos+4]) == "data" {
			return min(size, len(data)-pos-8)
		}
		pos += 8 + size + size%2
	}
	t.Fatalf("no data chunk in %s", path)
	return 0
}

func TestReplayPathValidation(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ok.wav"), []byte("RIFF"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{
		"",
		"../outside.wav",
		"sub/../../escape.wav",
		"/etc/passwd",
		"missing.wav",
		"sub", // a directory, not a file
	} {
		if _, err := NewReplay(dir, contract.FileReplayConfig{Path: path}); err == nil {
			t.Fatalf("expected rejection for path %q", path)
		}
	}
	if _, err := NewReplay(dir, contract.FileReplayConfig{Path: "ok.wav"}); err != nil {
		t.Fatalf("expected ok.wav accepted: %v", err)
	}
}

func TestReplayStreamsFixture(t *testing.T) {
	requireFFmpeg(t)
	wantMs := int64(wavDataBytes(t, filepath.Join(fixturesDir, "en-kubernetes-60s.wav")) / 32)

	replay, err := NewReplay(fixturesDir, contract.FileReplayConfig{Path: "en-kubernetes-60s.wav"})
	if err != nil {
		t.Fatalf("NewReplay: %v", err)
	}
	replay.pace = false // no realtime pacing in tests

	sink := &fakeSink{runID: "run-replay"}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	runErr := replay.Run(ctx, sink)

	var exited *ExitedError
	if !errors.As(runErr, &exited) {
		t.Fatalf("expected *ExitedError at end of file, got %v", runErr)
	}
	if exited.ExitCode != 0 {
		t.Fatalf("ffmpeg failed with code %d: %s", exited.ExitCode, exited.Stderr)
	}

	frames := sink.frameCount()
	if frames == 0 {
		t.Fatal("no frames streamed")
	}
	var firstStart, totalMs int64 = -1, 0
	for i := 0; i < frames; i++ {
		frame := sink.frameAt(i)
		if i == 0 {
			firstStart = frame.StartMs
		}
		if frame.StartMs < totalMs && i > 0 {
			t.Fatalf("frame %d start %d before received total %d", i, frame.StartMs, totalMs)
		}
		if len(frame.PCM)%2 != 0 {
			t.Fatalf("frame %d has odd PCM length %d", i, len(frame.PCM))
		}
		if i < frames-1 && len(frame.PCM) != frameBytes {
			t.Fatalf("frame %d is %d bytes, expected %d", i, len(frame.PCM), frameBytes)
		}
		totalMs += int64(len(frame.PCM)) / 32
	}
	if firstStart != 0 {
		t.Fatalf("first frame starts at %d, expected 0", firstStart)
	}
	if diff := wantMs - totalMs; diff < -frameBytes/32 || diff > frameBytes/32 {
		t.Fatalf("streamed %d ms of audio, file is %d ms (off by %d, one frame is %d)",
			totalMs, wantMs, diff, frameBytes/32)
	}
}

func TestReplayCancelStopsCleanly(t *testing.T) {
	requireFFmpeg(t)
	fixture := filepath.Join(fixturesDir, "en-kubernetes-60s.wav")
	if _, err := os.Stat(fixture); err != nil {
		t.Skipf("fixture not available: %v", err)
	}
	replay, err := NewReplay(fixturesDir, contract.FileReplayConfig{Path: "en-kubernetes-60s.wav", Loop: true})
	if err != nil {
		t.Fatalf("NewReplay: %v", err)
	}
	replay.pace = false

	sink := &fakeSink{runID: "run-replay"}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- replay.Run(ctx, sink) }()

	waitFor(t, "streamed frames", func() bool { return sink.frameCount() > 0 })
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("cancelled run returned %v, expected nil", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not stop after cancel")
	}
}

func TestReplayDecodeFailureReportsExit(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "garbage.wav")
	if err := os.WriteFile(path, []byte("this is not audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	replay, err := NewReplay(dir, contract.FileReplayConfig{Path: "garbage.wav"})
	if err != nil {
		t.Fatalf("NewReplay: %v", err)
	}
	replay.pace = false

	err = replay.Run(context.Background(), &fakeSink{runID: "run-replay"})
	var exited *ExitedError
	if !errors.As(err, &exited) {
		t.Fatalf("expected *ExitedError, got %v", err)
	}
	if exited.ExitCode == 0 {
		t.Fatal("expected a non-zero ffmpeg exit code for undecodable input")
	}
}
