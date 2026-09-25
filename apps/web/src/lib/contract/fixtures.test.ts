import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";

import {
	contractVersion,
	eventBatchSchema,
	healthResponseSchema,
	ingestHelloSchema,
	ingestReadySchema,
	ingestStatsSchema,
	sessionStartRequestSchema,
	sessionStartResponseSchema,
	sessionsResponseSchema,
} from "./index";
import { mintIngestToken, verifyIngestToken } from "./token.server";

const fixturesDirectory = new URL(
	"../../../../../packages/contract/fixtures/",
	import.meta.url,
);

function fixture(name: string): unknown {
	return JSON.parse(readFileSync(new URL(name, fixturesDirectory), "utf8"));
}

const fixtureSchemas: Record<string, ZodTypeAny> = {
	"events.batch.json": eventBatchSchema,
	"healthz.response.json": healthResponseSchema,
	"ingest.hello.json": ingestHelloSchema,
	"ingest.ready.json": ingestReadySchema,
	"ingest.stats.json": ingestStatsSchema,
	"session-start.request.json": sessionStartRequestSchema,
	"session-start.response.json": sessionStartResponseSchema,
	"sessions.response.json": sessionsResponseSchema,
};

describe("contract fixtures", () => {
	it("has a schema for every message fixture", () => {
		expect(readdirSync(fixturesDirectory).sort()).toEqual(
			[...Object.keys(fixtureSchemas), "ingest-token.vector.json"].sort(),
		);
	});

	it.each(Object.entries(fixtureSchemas))("round-trips %s", (name, schema) => {
		const original = fixture(name);
		const parsed = schema.parse(original);
		expect(JSON.parse(JSON.stringify(parsed))).toEqual(original);
	});

	it("rejects an incompatible version and malformed event", () => {
		expect(contractVersion).toBe(2);
		const batch = fixture("events.batch.json") as {
			contractVersion: number;
			events: Array<Record<string, unknown>>;
		};
		expect(
			eventBatchSchema.safeParse({ ...batch, contractVersion: 3 }).success,
		).toBe(false);
		expect(
			eventBatchSchema.safeParse({
				...batch,
				events: [{ ...batch.events[0], startMs: -1 }],
			}).success,
		).toBe(false);
	});

	it("keeps optional speaker labels and rejects an empty one", () => {
		const batch = eventBatchSchema.parse(fixture("events.batch.json"));
		const segments = batch.events.filter((event) => event.type === "segment");
		expect(segments[0]?.speaker).toBe("S1");
		expect(segments[1]?.speaker).toBe("S1");
		expect(
			eventBatchSchema.safeParse({
				...batch,
				events: [{ ...batch.events[0], speaker: "" }],
			}).success,
		).toBe(false);
		expect(
			eventBatchSchema.safeParse({
				...batch,
				events: [{ ...batch.events[0], speaker: undefined }],
			}).success,
		).toBe(true);
	});
});

describe("ingest tokens", () => {
	const vector = fixture("ingest-token.vector.json") as {
		secret: string;
		payload: string;
		expectedToken: string;
	};
	const claims = JSON.parse(
		Buffer.from(vector.payload, "base64url").toString("utf8"),
	) as {
		sessionId: string;
		exp: number;
	};
	const mintedAt = claims.exp - 600;

	it("reproduces the shared vector byte for byte", () => {
		expect(mintIngestToken(claims.sessionId, vector.secret, mintedAt)).toBe(
			vector.expectedToken,
		);
		expect(
			verifyIngestToken(
				vector.expectedToken,
				claims.sessionId,
				vector.secret,
				mintedAt,
			),
		).toBe(true);
	});

	it("rejects expiry, a different session, and a changed signature", () => {
		expect(
			verifyIngestToken(
				vector.expectedToken,
				claims.sessionId,
				vector.secret,
				claims.exp,
			),
		).toBe(false);
		expect(
			verifyIngestToken(
				vector.expectedToken,
				"5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77",
				vector.secret,
				mintedAt,
			),
		).toBe(false);
		const [payload, signature] = vector.expectedToken.split(".");
		expect(
			verifyIngestToken(
				`${payload}.A${signature?.slice(1)}`,
				claims.sessionId,
				vector.secret,
				mintedAt,
			),
		).toBe(false);
		const alphabet =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		const finalCharacter = signature?.at(-1) ?? "";
		const index = alphabet.indexOf(finalCharacter);
		const alternate = alphabet[(index & ~3) | ((index + 1) & 3)];
		expect(
			verifyIngestToken(
				`${payload}.${signature?.slice(0, -1)}${alternate}`,
				claims.sessionId,
				vector.secret,
				mintedAt,
			),
		).toBe(false);
		expect(
			verifyIngestToken("malformed", claims.sessionId, vector.secret, mintedAt),
		).toBe(false);
	});
});
