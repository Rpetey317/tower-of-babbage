package provider

import (
	"regexp"
	"strings"
)

// speakerTag matches the "S<n>: " prefix the ASR/AST prompts ask the model to
// emit ahead of the transcript. The colon is required so a transcript that
// legitimately starts with an "S1"-like token is not eaten.
var speakerTag = regexp.MustCompile(`^S(\d{1,2}):\s*`)

// splitSpeaker extracts a leading speaker tag from raw model output,
// returning the transcript body and the label ("S1"); output without a tag
// yields an empty speaker so unattributed chunks flow through unchanged.
func splitSpeaker(text string) (body, speaker string) {
	match := speakerTag.FindStringSubmatch(text)
	if match == nil {
		return text, ""
	}
	return strings.TrimSpace(text[len(match[0]):]), "S" + match[1]
}
