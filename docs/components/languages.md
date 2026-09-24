# Languages

Two separate concerns: the languages of the audio and captions (per session),
and the language of the interface (per visitor).

## Caption languages

- Identifiers are lowercase BCP 47 primary tags: `en`, `es`, `pt`, `fr`, `de`,
  `it`. Region subtags are not used; the model is prompted with the language
  name, and audiences pick by language, not locale.
- Each session declares `sourceLanguage` and an ordered `targetLanguages`
  list. The pipeline transcribes in the source language and translates into
  each target; the first target is the audience default.
- Spanish to English is just a session with `sourceLanguage: es`,
  `targetLanguages: ["en"]`. Nothing in the pipeline is direction-specific.
- The prompt layer maps codes to English names in one table
  (`provider/languages.go`); adding a language is one row there and one entry in
  the web app's `SUPPORTED_LANGUAGES` list (`apps/web/src/lib/languages.ts`) so
  it appears in the admin form.

Gemma 4 was trained on speech in many languages and its model card lists ASR
and speech translation as supported tasks without a fixed language list. Quality
must be checked per language pair; the roadmap task for M6 includes a
Portuguese fixture for that reason.

## Milestones

| Milestone | Supported |
| --- | --- |
| M1 | `en -> es` and `es -> en` hard-coded defaults in the admin form |
| M6 | Any combination from `SUPPORTED_LANGUAGES` (`en`, `es`, `pt` verified; others selectable, marked "unverified") |
| backlog | Automatic source-language detection (Gemma prompt variant), per-chunk language switching for bilingual speakers |

## Interface locale

- Locales: `es` (default, `NEXT_PUBLIC_DEFAULT_LOCALE`) and `en`.
- Selection order: `?hl=` query param, `tob_locale` cookie, `Accept-Language`, default.
- The M0-02 header toggle sets `?hl=` while preserving the current path and query;
  middleware stores a valid choice in `tob_locale` and passes the resolved locale
  to the server layout.
- Dictionaries in `apps/web/src/lib/i18n/{es,en}.ts` typed against a shared key
  type so a missing key fails type-checking. Helper `t(key, params)` on the
  server and a `useT()` hook on the client.
- Every user-visible string in the audience, overlay and admin pages goes
  through the dictionary. Admin pages may fall back to English strings during
  the hackathon but the keys must exist.

## Verification

- Vitest: locale resolution order; dictionary key parity between `es` and `en`
  (type-level plus a runtime test listing missing keys).
- Go: language code to name mapping rejects unknown codes at session start
  with a 400 `unsupported_language`.
- Manual for M6: replay `fixtures/audio/pt-sample-30s.wav` with
  `sourceLanguage: pt`, `targetLanguages: ["es"]`; captions are Portuguese and
  Spanish respectively.
