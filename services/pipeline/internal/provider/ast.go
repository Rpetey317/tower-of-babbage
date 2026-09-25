package provider

import (
	"fmt"
	"strings"
)

// ParseASTOutput splits raw AST model output on the first line starting with
// "{Target}:", the marker the prompt instructs the model to emit. The part
// before is the transcript (optionally prefixed by a speaker tag, see
// prompts.go), the rest is the translation; both are trimmed and newlines
// collapse to single spaces.
func ParseASTOutput(raw, targetCode string) (ASTResult, error) {
	target, err := LanguageName(targetCode)
	if err != nil {
		return ASTResult{}, err
	}
	marker := target + ":"
	lines := strings.Split(raw, "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, marker) {
			continue
		}
		text, speaker := splitSpeaker(collapseSpaces(strings.Join(lines[:i], " ")))
		translation := collapseSpaces(strings.Join(
			append([]string{strings.TrimSpace(trimmed[len(marker):])}, lines[i+1:]...), " "))
		if text == "" || translation == "" {
			return ASTResult{}, fmt.Errorf("ast output: empty transcript or translation around %q marker", marker)
		}
		return ASTResult{
			Transcript:  Transcript{Text: text, Speaker: speaker},
			Translation: translation,
		}, nil
	}
	return ASTResult{}, fmt.Errorf("ast output: missing %q marker line", marker)
}

func collapseSpaces(text string) string {
	return strings.Join(strings.Fields(text), " ")
}
