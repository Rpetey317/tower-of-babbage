import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const tokenLifetimeSeconds = 600;
const base64 =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const base64url = /^[A-Za-z0-9_-]+$/;
const claimsSchema = z
	.object({
		sessionId: z
			.string()
			.uuid()
			.regex(/^[0-9a-f-]+$/),
		exp: z.number().int().nonnegative(),
	})
	.strict();

function secretBytes(secret: string): Buffer {
	if (!base64.test(secret)) throw new Error("Invalid SHARED_SECRET encoding");
	const bytes = Buffer.from(secret, "base64");
	if (bytes.length < 32)
		throw new Error("SHARED_SECRET must be at least 32 bytes");
	return bytes;
}

function sign(payload: string, key: Buffer): Buffer {
	return createHmac("sha256", key).update(payload).digest();
}

export function mintIngestToken(
	sessionId: string,
	sharedSecret: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): string {
	const claims = claimsSchema.parse({
		sessionId,
		exp: nowSeconds + tokenLifetimeSeconds,
	});
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const signature = sign(payload, secretBytes(sharedSecret)).toString(
		"base64url",
	);
	return `${payload}.${signature}`;
}

export function verifyIngestToken(
	token: string,
	sessionId: string,
	sharedSecret: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
	const parts = token.split(".");
	if (parts.length !== 2) return false;
	const [payload, signature] = parts;
	if (
		!payload ||
		!signature ||
		!base64url.test(payload) ||
		!base64url.test(signature)
	) {
		return false;
	}

	const expected = sign(payload, secretBytes(sharedSecret));
	const supplied = Buffer.from(signature, "base64url");
	if (
		supplied.length !== expected.length ||
		!timingSafeEqual(supplied, expected)
	) {
		return false;
	}
	if (supplied.toString("base64url") !== signature) return false;

	try {
		const decoded = Buffer.from(payload, "base64url");
		if (decoded.toString("base64url") !== payload) return false;
		const claims = claimsSchema.parse(JSON.parse(decoded.toString("utf8")));
		return claims.sessionId === sessionId && claims.exp > nowSeconds;
	} catch {
		return false;
	}
}
