import { describe, expect, it } from "vitest";

import {
	adminCookieTtlSeconds,
	readCookie,
	signAdminCookie,
	verifyAdminCookie,
} from "./admin-cookie";

const secret = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=";
const otherSecret = Buffer.from("x".repeat(32)).toString("base64");
const now = 1_758_810_000;

describe("admin cookie", () => {
	it("signs `expiry.signature` and verifies it", async () => {
		const value = await signAdminCookie(secret, now);
		const [expiry, signature] = value.split(".");
		expect(expiry).toBe(String(now + adminCookieTtlSeconds));
		expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);

		expect(await verifyAdminCookie(value, secret, now)).toBe(true);
	});

	it("accepts a cookie partway through its 12-hour life", async () => {
		const value = await signAdminCookie(secret, now);
		expect(
			await verifyAdminCookie(value, secret, now + adminCookieTtlSeconds - 1),
		).toBe(true);
	});

	it("rejects an expired cookie", async () => {
		const value = await signAdminCookie(secret, now);
		expect(
			await verifyAdminCookie(value, secret, now + adminCookieTtlSeconds),
		).toBe(false);
	});

	it("rejects a tampered expiry and signature", async () => {
		const value = await signAdminCookie(secret, now);
		const [expiry, signature] = value.split(".");

		expect(
			await verifyAdminCookie(`${now + 99_999}.${signature}`, secret, now),
		).toBe(false);
		expect(
			await verifyAdminCookie(
				`${expiry}.${signature?.slice(0, -4)}AAAA`,
				secret,
				now,
			),
		).toBe(false);
	});

	it("rejects a cookie signed with another secret", async () => {
		const value = await signAdminCookie(otherSecret, now);
		expect(await verifyAdminCookie(value, secret, now)).toBe(false);
	});

	it("rejects malformed values", async () => {
		for (const value of [
			"",
			"nosignature",
			".abc",
			"abc.",
			"notanumber.abc",
			"1.signature with space",
		]) {
			expect(await verifyAdminCookie(value, secret, now)).toBe(false);
		}
		expect(await verifyAdminCookie(undefined, secret, now)).toBe(false);
	});
});

describe("readCookie", () => {
	it("finds a cookie in a header string", () => {
		expect(readCookie("tob_locale=es; tob_admin=123.abc", "tob_admin")).toBe(
			"123.abc",
		);
	});

	it("returns undefined for missing cookie or header", () => {
		expect(readCookie("tob_locale=es", "tob_admin")).toBeUndefined();
		expect(readCookie(null, "tob_admin")).toBeUndefined();
	});
});
