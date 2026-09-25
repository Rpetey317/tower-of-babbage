package provider

import (
	"testing"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
)

func strPtr(s string) *string { return &s }

func TestEnforceGlossary(t *testing.T) {
	cases := []struct {
		name            string
		text            string
		glossary        []contract.GlossaryTerm
		useTranslations bool
		want            string
	}{
		{
			name:            "canonical spelling in transcript",
			text:            "We deploy with Kubectl and KUBECTL every day.",
			glossary:        []contract.GlossaryTerm{{Term: "kubectl"}},
			useTranslations: false,
			want:            "We deploy with kubectl and kubectl every day.",
		},
		{
			name:            "inside a larger word is untouched",
			text:            "kubectlx and mykubectl stay, my_kubectl too.",
			glossary:        []contract.GlossaryTerm{{Term: "kubectl"}},
			useTranslations: false,
			want:            "kubectlx and mykubectl stay, my_kubectl too.",
		},
		{
			name:            "punctuation and end of string are boundaries",
			text:            "(kubectl), kubectl.",
			glossary:        []contract.GlossaryTerm{{Term: "Kubectl"}},
			useTranslations: false,
			want:            "(Kubectl), Kubectl.",
		},
		{
			name:            "multi-word term",
			text:            "She opened a Pull Request today.",
			glossary:        []contract.GlossaryTerm{{Term: "pull request"}},
			useTranslations: false,
			want:            "She opened a pull request today.",
		},
		{
			name:            "translated term replaced in translation",
			text:            "Abrí un pull request ayer.",
			glossary:        []contract.GlossaryTerm{{Term: "pull request", Translation: strPtr("PR")}},
			useTranslations: true,
			want:            "Abrí un PR ayer.",
		},
		{
			name:            "translation ignored in transcript",
			text:            "Open a Pull Request, please.",
			glossary:        []contract.GlossaryTerm{{Term: "pull request", Translation: strPtr("PR")}},
			useTranslations: false,
			want:            "Open a pull request, please.",
		},
		{
			name:            "nil translation keeps canonical term",
			text:            "Charla en nerdearla.",
			glossary:        []contract.GlossaryTerm{{Term: "Nerdearla"}},
			useTranslations: true,
			want:            "Charla en Nerdearla.",
		},
		{
			name:            "empty glossary is a no-op",
			text:            "Nothing to change.",
			glossary:        nil,
			useTranslations: true,
			want:            "Nothing to change.",
		},
		{
			name:            "empty term is skipped",
			text:            "Unchanged.",
			glossary:        []contract.GlossaryTerm{{Term: ""}},
			useTranslations: true,
			want:            "Unchanged.",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := EnforceGlossary(tc.text, tc.glossary, tc.useTranslations); got != tc.want {
				t.Fatalf("EnforceGlossary(%q) = %q, want %q", tc.text, got, tc.want)
			}
		})
	}
}
