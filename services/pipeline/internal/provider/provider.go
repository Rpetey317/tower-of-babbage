// Package provider turns audio chunks into transcripts and translations
// through one interface, implemented once per backend (Gemma 4 on llama.cpp or
// vLLM, Gemini, mock). See docs/components/speech-engine.md.
package provider

import (
	"context"
	"errors"
	"fmt"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
)

// ErrUnavailable reports that inference is unreachable; the runner surfaces it
// as provider_unavailable and keeps dropping chunks until the backend recovers.
var ErrUnavailable = errors.New("provider: inference unavailable")

// ErrBadOutput wraps errors from parsing model output (for example a missing
// AST marker); the runner logs provider_bad_output and falls back to
// Transcribe + Translate.
var ErrBadOutput = errors.New("provider: unparseable model output")

// RequestError is an HTTP error response from the backend. 4xx rejections
// (except 429) are non-retryable; 5xx and 429 may be retried. The runner logs
// it and skips the chunk.
type RequestError struct {
	Status  int
	Message string
}

func (e *RequestError) Error() string {
	return fmt.Sprintf("provider: status %d: %s", e.Status, e.Message)
}

// SpeechProvider is implemented once per backend. Implementations are safe for
// concurrent use; the session runner limits in-flight calls.
type SpeechProvider interface {
	// Transcribe returns the transcript of a chunk in its source language.
	Transcribe(ctx context.Context, audio WAV, req TranscribeRequest) (Transcript, error)
	// TranscribeAndTranslate returns transcript and translation from one audio call
	// (Gemma 4 AST prompt). ok=false means the backend cannot do it in one call and
	// the runner must fall back to Transcribe + Translate.
	TranscribeAndTranslate(ctx context.Context, audio WAV, req ASTRequest) (ASTResult, bool, error)
	// Translate translates text between two languages.
	Translate(ctx context.Context, text string, req TranslateRequest) (string, error)
	// Healthy reports whether at least one endpoint is usable.
	Healthy() bool
}

// WAV is one audio chunk encoded as 16-bit PCM WAV, stamped with its position
// in the run so transcripts and logs keep exact audio times.
type WAV struct {
	Data    []byte
	Index   int
	StartMs int
	EndMs   int
}

// Transcript is recognized speech in the session's source language, with the
// optional speaker label the provider attributed to the chunk ("S1", "S2",
// ...; empty when the provider did not attribute the chunk).
type Transcript struct {
	Text    string
	Speaker string
}

// TranscribeRequest describes one transcription call. Glossary holds session
// terms before global ones.
type TranscribeRequest struct {
	SourceLanguage string
	Glossary       []contract.GlossaryTerm
}

type ASTRequest struct {
	SourceLanguage string
	TargetLanguage string
	Glossary       []contract.GlossaryTerm
}

type TranslateRequest struct {
	SourceLanguage string
	TargetLanguage string
	Glossary       []contract.GlossaryTerm
}

type ASTResult struct {
	Transcript  Transcript
	Translation string
}
