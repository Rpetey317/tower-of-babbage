package provider

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMockCannedOutput(t *testing.T) {
	mock := NewMock(0, nil)
	audio := WAV{Data: []byte("wav"), Index: 12, StartMs: 72000, EndMs: 78400}

	transcript, err := mock.Transcribe(context.Background(), audio, TranscribeRequest{SourceLanguage: "en"})
	if err != nil {
		t.Fatal(err)
	}
	if transcript.Text != "[mock en] chunk 12, 72.0s-78.4s" {
		t.Fatalf("unexpected transcript %q", transcript.Text)
	}

	result, ok, err := mock.TranscribeAndTranslate(context.Background(), audio, ASTRequest{SourceLanguage: "en", TargetLanguage: "es"})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("mock must support single-call AST")
	}
	if result.Transcript.Text != "[mock en] chunk 12, 72.0s-78.4s" || result.Translation != "[mock es] fragmento 12, 72.0s-78.4s" {
		t.Fatalf("unexpected AST result %+v", result)
	}

	translation, err := mock.Translate(context.Background(), "hello", TranslateRequest{SourceLanguage: "en", TargetLanguage: "es"})
	if err != nil {
		t.Fatal(err)
	}
	if translation != "[mock es] hello" {
		t.Fatalf("unexpected translation %q", translation)
	}

	if !mock.Healthy() {
		t.Fatal("mock must always be healthy")
	}
}

func TestMockLinesDeterministic(t *testing.T) {
	lines := []string{"first line", "second line"}
	mock := NewMock(0, lines)
	audio := WAV{Index: 1}
	want := []string{"first line", "second line", "first line"}
	for i, expected := range want {
		transcript, err := mock.Transcribe(context.Background(), audio, TranscribeRequest{SourceLanguage: "en"})
		if err != nil {
			t.Fatal(err)
		}
		if transcript.Text != expected {
			t.Fatalf("call %d: got %q, want %q", i, transcript.Text, expected)
		}
	}

	// A second provider with the same file produces the same sequence.
	other := NewMock(0, lines)
	for i, expected := range want[:2] {
		result, _, err := other.TranscribeAndTranslate(context.Background(), audio, ASTRequest{SourceLanguage: "en", TargetLanguage: "es"})
		if err != nil {
			t.Fatal(err)
		}
		if result.Transcript.Text != expected {
			t.Fatalf("call %d: got %q, want %q", i, result.Transcript.Text, expected)
		}
	}
}

func TestMockRotatingSpeakers(t *testing.T) {
	mock := NewMock(0, nil)
	// Chunks alternate speakers in pairs: S1, S1, S2, S2, ...
	want := []string{"S1", "S1", "S2", "S2", "S1"}
	for index, speaker := range want {
		transcript, err := mock.Transcribe(context.Background(), WAV{Index: index}, TranscribeRequest{SourceLanguage: "en"})
		if err != nil {
			t.Fatal(err)
		}
		if transcript.Speaker != speaker {
			t.Fatalf("chunk %d: got speaker %q, want %q", index, transcript.Speaker, speaker)
		}
	}
}

func TestLoadMockLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "en-fixture.mock.txt")
	if err := os.WriteFile(path, []byte("one\n\n two  \nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, err := LoadMockLines(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 3 || lines[1] != "two" {
		t.Fatalf("unexpected lines %v", lines)
	}
	if _, err := LoadMockLines(filepath.Join(t.TempDir(), "missing.mock.txt")); err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestMockHonorsContextAndLatency(t *testing.T) {
	mock := NewMock(50*time.Millisecond, nil)
	start := time.Now()
	if _, err := mock.Transcribe(context.Background(), WAV{}, TranscribeRequest{SourceLanguage: "en"}); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed < 50*time.Millisecond {
		t.Fatalf("latency not applied: %v", elapsed)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	if _, err := mock.Transcribe(ctx, WAV{}, TranscribeRequest{SourceLanguage: "en"}); err == nil {
		t.Fatal("expected context deadline error")
	}
}

func TestMockConcurrentUse(t *testing.T) {
	mock := NewMock(0, []string{"a", "b"})
	done := make(chan struct{})
	for range 8 {
		go func() {
			defer func() { done <- struct{}{} }()
			for range 20 {
				transcript, err := mock.Transcribe(context.Background(), WAV{}, TranscribeRequest{SourceLanguage: "en"})
				if err != nil {
					t.Error(err)
					return
				}
				if transcript.Text != "a" && transcript.Text != "b" {
					t.Errorf("unexpected transcript %q", transcript.Text)
					return
				}
			}
		}()
	}
	for range 8 {
		<-done
	}
}
