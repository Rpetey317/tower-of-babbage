package provider

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
)

// EnforceGlossary rewrites whole-word, case-insensitive occurrences of the
// glossary terms in provider output. In transcripts (useTranslations=false)
// each term is rewritten to its canonical spelling; in translations it is
// rewritten to its translation, or to the term itself when the glossary says
// to keep it as is. Applied when the pipeline runs with GLOSSARY_ENFORCE
// (docs/components/glossary.md). Terms apply in list order, so session terms
// win over global ones when they overlap.
func EnforceGlossary(text string, glossary []contract.GlossaryTerm, useTranslations bool) string {
	for _, term := range glossary {
		with := term.Term
		if useTranslations && term.Translation != nil && *term.Translation != "" {
			with = *term.Translation
		}
		text = replaceTerm(text, term.Term, with)
	}
	return text
}

// replaceTerm swaps every whole-word, case-insensitive occurrence of match
// for with. A boundary is a position not flanked by a letter, digit or
// underscore, so "kubectlx" and "mykubectl" stay untouched.
func replaceTerm(text, match, with string) string {
	if match == "" {
		return text
	}
	indexes := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(match)).FindAllStringIndex(text, -1)
	if len(indexes) == 0 {
		return text
	}
	var out strings.Builder
	out.Grow(len(text))
	tail := 0
	for _, span := range indexes {
		if wordCharBefore(text, span[0]) || wordCharAfter(text, span[1]) {
			continue
		}
		out.WriteString(text[tail:span[0]])
		out.WriteString(with)
		tail = span[1]
	}
	out.WriteString(text[tail:])
	return out.String()
}

// wordCharBefore/After inspect the runes immediately flanking a byte span;
// letter, digit and underscore count as word characters.
func wordCharBefore(text string, at int) bool {
	if at == 0 {
		return false
	}
	r, _ := utf8.DecodeLastRuneInString(text[:at])
	return isWordChar(r)
}

func wordCharAfter(text string, at int) bool {
	if at >= len(text) {
		return false
	}
	r, _ := utf8.DecodeRuneInString(text[at:])
	return isWordChar(r)
}

func isWordChar(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_'
}
