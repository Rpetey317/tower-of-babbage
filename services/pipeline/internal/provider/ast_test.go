package provider

import (
	"strings"
	"testing"
)

func TestParseASTOutput(t *testing.T) {
	tests := []struct {
		name             string
		raw              string
		target           string
		wantTranscript   string
		wantTranslation  string
		wantSpeaker      string
		wantErrSubstring string
	}{
		{
			name:            "well formed",
			raw:             "hello world\nSpanish: hola mundo",
			target:          "es",
			wantTranscript:  "hello world",
			wantTranslation: "hola mundo",
		},
		{
			name:            "speaker tag",
			raw:             "S1: hello world\nSpanish: hola mundo",
			target:          "es",
			wantTranscript:  "hello world",
			wantTranslation: "hola mundo",
			wantSpeaker:     "S1",
		},
		{
			name:            "speaker tag on a later speaker",
			raw:             "S2: we move on\nSpanish: seguimos",
			target:          "es",
			wantTranscript:  "we move on",
			wantTranslation: "seguimos",
			wantSpeaker:     "S2",
		},
		{
			name:            "speaker-like token without colon is kept",
			raw:             "S1 songs are short\nSpanish: las canciones son cortas",
			target:          "es",
			wantTranscript:  "S1 songs are short",
			wantTranslation: "las canciones son cortas",
		},
		{
			name:            "multi-line transcript and translation",
			raw:             "first line\nsecond line\nSpanish: primera linea\nsegunda linea",
			target:          "es",
			wantTranscript:  "first line second line",
			wantTranslation: "primera linea segunda linea",
		},
		{
			name:            "marker and padding whitespace",
			raw:             "  the talk today  \n\nSpanish:   la charla de hoy  ",
			target:          "es",
			wantTranscript:  "the talk today",
			wantTranslation: "la charla de hoy",
		},
		{
			name:            "marker name is not matched mid-line",
			raw:             "the note says Spanish: no marker here\nSpanish: la charla",
			target:          "es",
			wantTranscript:  "the note says Spanish: no marker here",
			wantTranslation: "la charla",
		},
		{
			name:             "missing marker",
			raw:              "hello world\nhola mundo",
			target:           "es",
			wantErrSubstring: `missing "Spanish:"`,
		},
		{
			name:             "marker without translation",
			raw:              "hello world\nSpanish:",
			target:           "es",
			wantErrSubstring: "empty transcript or translation",
		},
		{
			name:             "marker without transcript",
			raw:              "Spanish: hola mundo",
			target:           "es",
			wantErrSubstring: "empty transcript or translation",
		},
		{
			name:             "tag only, no transcript",
			raw:              "S1:\nSpanish: hola mundo",
			target:           "es",
			wantErrSubstring: "empty transcript or translation",
		},
		{
			name:             "wrong language marker",
			raw:              "hello world\nFrench: bonjour",
			target:           "es",
			wantErrSubstring: `missing "Spanish:"`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := ParseASTOutput(test.raw, test.target)
			if test.wantErrSubstring != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErrSubstring) {
					t.Fatalf("expected error containing %q, got %v", test.wantErrSubstring, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.Transcript.Text != test.wantTranscript ||
				result.Transcript.Speaker != test.wantSpeaker ||
				result.Translation != test.wantTranslation {
				t.Fatalf("got %+v, want transcript %q speaker %q translation %q",
					result, test.wantTranscript, test.wantSpeaker, test.wantTranslation)
			}
		})
	}
}
