package provider

import "testing"

func TestLanguageName(t *testing.T) {
	for code, want := range map[string]string{
		"en": "English",
		"es": "Spanish",
		"pt": "Portuguese",
		"fr": "French",
		"de": "German",
		"it": "Italian",
	} {
		got, err := LanguageName(code)
		if err != nil || got != want {
			t.Fatalf("LanguageName(%q) = %q, %v; want %q", code, got, err, want)
		}
	}
	if _, err := LanguageName("en-US"); err == nil {
		t.Fatal("expected error for region subtag")
	}
}
