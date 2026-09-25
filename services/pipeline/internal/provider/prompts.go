// Prompt structures follow Google's guidance for Gemma 4, as specified in
// docs/components/speech-engine.md.
package provider

import (
	"fmt"
	"strings"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
)

// glossaryCap bounds how many terms reach the model prompt.
const glossaryCap = 40

// ASRPrompt renders the prompt for SpeechProvider.Transcribe.
func ASRPrompt(sourceCode string, glossary []contract.GlossaryTerm) (string, error) {
	source, err := LanguageName(sourceCode)
	if err != nil {
		return "", err
	}
	return joinLines(
		fmt.Sprintf("Transcribe the following speech segment in %s into %s text.\n\nFollow these specific instructions for formatting the answer:\n* Only output the transcription, with no newlines.\n* When transcribing numbers, write the digits, i.e. write 1.7 and not one point seven, and write 3 instead of three.", source, source),
		glossaryBlock(glossary),
	), nil
}

// ASTPrompt renders the prompt for SpeechProvider.TranscribeAndTranslate.
func ASTPrompt(sourceCode, targetCode string, glossary []contract.GlossaryTerm) (string, error) {
	source, err := LanguageName(sourceCode)
	if err != nil {
		return "", err
	}
	target, err := LanguageName(targetCode)
	if err != nil {
		return "", err
	}
	return joinLines(
		fmt.Sprintf("Transcribe the following speech segment in %s, then translate it into %s.\nWhen formatting the answer, first output the transcription in %s, then one newline, then output the string '%s: ', then the translation in %s.", source, target, source, target, target),
		glossaryBlock(glossary),
	), nil
}

// TranslatePrompt renders the prompt for SpeechProvider.Translate.
func TranslatePrompt(sourceCode, targetCode, text string, glossary []contract.GlossaryTerm) (string, error) {
	source, err := LanguageName(sourceCode)
	if err != nil {
		return "", err
	}
	target, err := LanguageName(targetCode)
	if err != nil {
		return "", err
	}
	return joinLines(
		fmt.Sprintf("Translate the following %s text into %s. Output only the translation, on one line.", source, target),
		glossaryBlock(glossary),
	) + "\n\n" + text, nil
}

// glossaryBlock renders the terminology instructions appended to every prompt.
// Terms without a translation are listed for exact spelling; terms with one
// are listed with their preferred rendering. The list is capped and keeps the
// caller's ordering, so session terms win over global ones.
func glossaryBlock(glossary []contract.GlossaryTerm) string {
	var exact, translated []string
	for _, term := range glossary[:min(len(glossary), glossaryCap)] {
		if term.Translation == nil {
			exact = append(exact, term.Term)
		} else {
			translated = append(translated, fmt.Sprintf("%s -> %s", term.Term, *term.Translation))
		}
	}
	var lines []string
	if len(exact) > 0 {
		lines = append(lines, "Technical terms and proper names that may appear. Spell them exactly as written: "+strings.Join(exact, ", ")+".")
	}
	if len(translated) > 0 {
		lines = append(lines, "Translate these terms as indicated: "+strings.Join(translated, "; ")+".")
	}
	return strings.Join(lines, "\n")
}

func joinLines(lines ...string) string {
	var kept []string
	for _, line := range lines {
		if line != "" {
			kept = append(kept, line)
		}
	}
	return strings.Join(kept, "\n")
}
