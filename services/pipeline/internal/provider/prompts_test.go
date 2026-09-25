package provider

import (
	"fmt"
	"strings"
	"testing"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
)

func term(text string) contract.GlossaryTerm {
	return contract.GlossaryTerm{Term: text}
}

func termTranslated(text, translation string) contract.GlossaryTerm {
	return contract.GlossaryTerm{Term: text, Translation: &translation}
}

func TestASRPrompt(t *testing.T) {
	tests := []struct {
		name     string
		source   string
		glossary []contract.GlossaryTerm
		want     string
	}{
		{
			name:   "no glossary",
			source: "en",
			want: "Transcribe the following speech segment in English into English text.\n\n" +
				"Follow these specific instructions for formatting the answer:\n" +
				"* Only output the transcription, with no newlines.\n" +
				"* When transcribing numbers, write the digits, i.e. write 1.7 and not one point seven, and write 3 instead of three.",
		},
		{
			name:   "with glossary",
			source: "es",
			glossary: []contract.GlossaryTerm{
				term("Kubernetes"),
				termTranslated("pull request", "pull request"),
				termTranslated("deployment", "despliegue"),
			},
			want: "Transcribe the following speech segment in Spanish into Spanish text.\n\n" +
				"Follow these specific instructions for formatting the answer:\n" +
				"* Only output the transcription, with no newlines.\n" +
				"* When transcribing numbers, write the digits, i.e. write 1.7 and not one point seven, and write 3 instead of three.\n" +
				"Technical terms and proper names that may appear. Spell them exactly as written: Kubernetes.\n" +
				"Translate these terms as indicated: pull request -> pull request; deployment -> despliegue.",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := ASRPrompt(test.source, test.glossary)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("prompt mismatch\ngot:\n%s\nwant:\n%s", got, test.want)
			}
		})
	}
}

func TestASTPrompt(t *testing.T) {
	got, err := ASTPrompt("en", "es", []contract.GlossaryTerm{term("Nerdearla")})
	if err != nil {
		t.Fatal(err)
	}
	want := "Transcribe the following speech segment in English, then translate it into Spanish.\n" +
		"When formatting the answer, first output the transcription in English, then one newline, then output the string 'Spanish: ', then the translation in Spanish.\n" +
		"Technical terms and proper names that may appear. Spell them exactly as written: Nerdearla."
	if got != want {
		t.Fatalf("prompt mismatch\ngot:\n%s\nwant:\n%s", got, want)
	}
}

func TestTranslatePrompt(t *testing.T) {
	tests := []struct {
		name     string
		glossary []contract.GlossaryTerm
		want     string
	}{
		{
			name: "no glossary",
			want: "Translate the following English text into Spanish. Output only the translation, on one line.\n\n" +
				"Kubernetes runs containers.",
		},
		{
			name:     "with glossary",
			glossary: []contract.GlossaryTerm{termTranslated("deployment", "despliegue")},
			want: "Translate the following English text into Spanish. Output only the translation, on one line.\n" +
				"Translate these terms as indicated: deployment -> despliegue.\n\n" +
				"Kubernetes runs containers.",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := TranslatePrompt("en", "es", "Kubernetes runs containers.", test.glossary)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("prompt mismatch\ngot:\n%s\nwant:\n%s", got, test.want)
			}
		})
	}
}

func TestGlossaryCap(t *testing.T) {
	// 30 exact-spelling terms followed by 30 translated terms: the block keeps
	// the first 40 in caller order, so session terms win over global ones.
	var glossary []contract.GlossaryTerm
	for i := range 30 {
		glossary = append(glossary, term(fmt.Sprintf("Term%02d", i)))
	}
	for i := 30; i < 60; i++ {
		glossary = append(glossary, termTranslated(fmt.Sprintf("Term%02d", i), fmt.Sprintf("Trad%02d", i)))
	}
	prompt, err := ASRPrompt("en", glossary)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 60 {
		term := fmt.Sprintf("Term%02d", i)
		if i < 40 && !strings.Contains(prompt, term) {
			t.Fatalf("expected %s in prompt:\n%s", term, prompt)
		}
		if i >= 40 && strings.Contains(prompt, term) {
			t.Fatalf("expected %s to be capped out of prompt:\n%s", term, prompt)
		}
	}
	if !strings.Contains(prompt, "Trad30") || strings.Contains(prompt, "Trad40") {
		t.Fatalf("cap boundary wrong in prompt:\n%s", prompt)
	}
}

func TestPromptRejectsUnknownLanguage(t *testing.T) {
	for _, call := range []func() error{
		func() error { _, err := ASRPrompt("xx", nil); return err },
		func() error { _, err := ASTPrompt("en", "xx", nil); return err },
		func() error { _, err := ASTPrompt("xx", "es", nil); return err },
		func() error { _, err := TranslatePrompt("en", "xx", "text", nil); return err },
		func() error { _, err := ParseASTOutput("out", "xx"); return err },
	} {
		if err := call(); err == nil || !strings.Contains(err.Error(), "unsupported language") {
			t.Fatalf("expected unsupported language error, got %v", err)
		}
	}
}
