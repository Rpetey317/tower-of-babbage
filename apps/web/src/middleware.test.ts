import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { signAdminCookie } from "~/lib/auth/admin-cookie";

import { middleware } from "./middleware";

const secret = process.env.AUTH_SECRET ?? "";

function request(path: string, cookie?: string) {
	return new NextRequest(new URL(path, "http://localhost:3000"), {
		headers: cookie ? { cookie } : {},
	});
}

describe("middleware admin gate", () => {
	it("redirects /admin to /admin/login without a cookie", async () => {
		const response = await middleware(request("/admin"));
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"http://localhost:3000/admin/login",
		);
	});

	it("redirects nested admin pages without a valid cookie", async () => {
		for (const cookie of [undefined, "tob_admin=forged"]) {
			const response = await middleware(request("/admin/sessions/new", cookie));
			expect(response.status).toBe(307);
			expect(response.headers.get("location")).toContain("/admin/login");
		}
	});

	it("lets /admin/login through without a cookie", async () => {
		const response = await middleware(request("/admin/login"));
		expect(response.headers.get("location")).toBeNull();
	});

	it("lets /admin through with a valid cookie", async () => {
		const value = await signAdminCookie(secret);
		const response = await middleware(request("/admin", `tob_admin=${value}`));
		expect(response.headers.get("location")).toBeNull();
	});

	it("does not gate non-admin pages", async () => {
		const response = await middleware(request("/"));
		expect(response.headers.get("location")).toBeNull();
	});
});
