package provider

import "fmt"

// languageNames maps BCP 47 primary tags to the English names used in prompts.
// Adding a language is one row here plus an entry in the web app's
// SUPPORTED_LANGUAGES (docs/components/languages.md).
var languageNames = map[string]string{
	"en": "English",
	"es": "Spanish",
	"pt": "Portuguese",
	"fr": "French",
	"de": "German",
	"it": "Italian",
}

// LanguageName returns the English name a language code is prompted with, or
// an error for codes outside the table (surfaced as unsupported_language).
func LanguageName(code string) (string, error) {
	name, ok := languageNames[code]
	if !ok {
		return "", fmt.Errorf("unsupported language %q", code)
	}
	return name, nil
}
