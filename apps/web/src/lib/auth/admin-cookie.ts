/**
 * Admin session cookie `tob_admin`: `expiry.signature` where expiry is the
 * unix-seconds expiry timestamp and signature is base64url(HMAC-SHA256) of the
 * expiry string, keyed by AUTH_SECRET. Isomorphic: runs in edge middleware and
 * in Node (tRPC, tests) through Web Crypto — no `node:crypto` or `Buffer`.
 */
export const adminCookieName = "tob_admin";
export const adminCookieTtlSeconds = 12 * 60 * 60;

const base64 =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const base64url = /^[A-Za-z0-9_-]+$/;

function secretBytes(secret: string): Uint8Array {
	if (!base64.test(secret)) throw new Error("Invalid AUTH_SECRET encoding");
	const binary = atob(secret);
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	if (bytes.length < 32)
		throw new Error("AUTH_SECRET must be at least 32 bytes");
	return bytes;
}

function toBase64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(message: string, secret: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		secretBytes(secret) as BufferSource,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(message),
	);
	return new Uint8Array(signature);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return diff === 0;
}

export async function signAdminCookie(
	secret: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
	const expiry = String(nowSeconds + adminCookieTtlSeconds);
	return `${expiry}.${toBase64url(await hmac(expiry, secret))}`;
}

export async function verifyAdminCookie(
	value: string | undefined,
	secret: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
	if (!value) return false;
	const separator = value.indexOf(".");
	if (separator <= 0) return false;
	const expiry = value.slice(0, separator);
	const signature = value.slice(separator + 1);
	if (!/^[0-9]+$/.test(expiry) || !base64url.test(signature)) return false;
	if (Number(expiry) <= nowSeconds) return false;

	try {
		const expected = await hmac(expiry, secret);
		return equalBytes(fromBase64url(signature), expected);
	} catch {
		return false;
	}
}

/** Read one cookie out of a `Cookie` request header string. */
export function readCookie(
	header: string | null,
	name: string,
): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return undefined;
}
