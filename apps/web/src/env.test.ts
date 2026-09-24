import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const example = readFileSync(
	new URL("../.env.example", import.meta.url),
	"utf8",
);

function exampleValue(name: string): string {
	const line = example
		.split("\n")
		.find((entry) => entry.startsWith(`${name}=`));
	if (!line) throw new Error(`Missing example value for ${name}`);
	return line.slice(name.length + 1).replace(/^"|"$/g, "");
}

const examplePassword = exampleValue("ADMIN_PASSWORD");
const exampleAuthSecret = exampleValue("AUTH_SECRET");
const exampleSharedSecret = exampleValue("SHARED_SECRET");
const strongSecret = Buffer.alloc(32, 65).toString("base64");

function validateEnvironment(
	mode: "development" | "production",
	overrides: Record<string, string> = {},
) {
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "--eval", "import('./src/env.js')"],
		{
			cwd: appDirectory,
			encoding: "utf8",
			env: {
				...process.env,
				NODE_ENV: mode,
				DATABASE_URL: exampleValue("DATABASE_URL"),
				DATABASE_URL_TEST: "",
				ADMIN_PASSWORD: "a-long-synthetic-password",
				AUTH_SECRET: strongSecret,
				SHARED_SECRET: strongSecret,
				PIPELINE_URL: exampleValue("PIPELINE_URL"),
				NEXT_PUBLIC_PIPELINE_WS_URL: exampleValue(
					"NEXT_PUBLIC_PIPELINE_WS_URL",
				),
				NEXT_PUBLIC_DEFAULT_LOCALE: "es",
				...overrides,
			},
		},
	);
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("web environment validation", () => {
	it("accepts local example values in development", () => {
		const result = validateEnvironment("development", {
			ADMIN_PASSWORD: examplePassword,
			AUTH_SECRET: exampleAuthSecret,
			SHARED_SECRET: exampleSharedSecret,
		});
		expect(result.status, result.output).toBe(0);
	});

	it("accepts replacement values in production", () => {
		const result = validateEnvironment("production");
		expect(result.status, result.output).toBe(0);
	});

	it.each([
		["example password", { ADMIN_PASSWORD: examplePassword }, "ADMIN_PASSWORD"],
		["short password", { ADMIN_PASSWORD: "short" }, "ADMIN_PASSWORD"],
		["example auth secret", { AUTH_SECRET: exampleAuthSecret }, "AUTH_SECRET"],
		[
			"example shared secret",
			{ SHARED_SECRET: exampleSharedSecret },
			"SHARED_SECRET",
		],
		[
			"short base64 secret",
			{ AUTH_SECRET: Buffer.alloc(16, 65).toString("base64") },
			"AUTH_SECRET",
		],
	])("rejects %s in production", (_case, overrides, field) => {
		const result = validateEnvironment("production", overrides);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain(field);
	});
});
