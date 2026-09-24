# Web scaffold (M0-02)

Scaffolded the Next.js 15 T3 web app with tRPC, Drizzle/Postgres, Tailwind 4,
Biome, and Vitest. Added validation for the documented web environment
variables and a database-backed `/api/health` route. Replaced the generated
demo page with a branded empty sessions layout and an ES/EN locale toggle.

The toggle preserves the current URL, and middleware resolves the locale from
the query, cookie, browser language, and configured default. Added the project
palette and self-hosted Barlow Condensed, Inter, and Atkinson Hyperlegible
fonts. The application schema and API routers remain empty for M1-01 onward.

Review follow-up: production environment validation now rejects committed
example credentials and short admin passwords, and locale parsing honors
whitespace in `Accept-Language` quality weights.

Verification: `pnpm --dir apps/web lint`, `pnpm --dir apps/web typecheck`,
`pnpm --dir apps/web test`, and live `GET /` and `GET /api/health` against the
Compose Postgres service.
