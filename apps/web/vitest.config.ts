import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"~": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	// tsconfig keeps `jsx: preserve` for Next; tests need the automatic
	// runtime to render components without a React import.
	esbuild: { jsx: "automatic" },
	test: {
		// Test files share the same database; run them sequentially.
		fileParallelism: false,
		// Route tests run against a dedicated database (see docs/testing.md).
		env: {
			DATABASE_URL:
				process.env.DATABASE_URL_TEST ??
				"postgres://babbage:babbage@localhost:5432/babbage_test",
			ADMIN_PASSWORD: "test-password",
			AUTH_SECRET: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
			SHARED_SECRET: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
			PIPELINE_URL: "http://localhost:8090",
			NEXT_PUBLIC_PIPELINE_WS_URL: "ws://localhost:8090",
		},
	},
});
