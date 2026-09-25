"use server";

import { timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { env } from "~/env";
import {
	adminCookieName,
	adminCookieTtlSeconds,
	signAdminCookie,
} from "~/lib/auth/admin-cookie";

function passwordMatches(candidate: string, expected: string): boolean {
	const a = Buffer.from(candidate);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export type LoginState = { error: "invalid_password" | null };

export async function login(
	_previous: LoginState,
	formData: FormData,
): Promise<LoginState> {
	const password = formData.get("password");
	if (
		typeof password !== "string" ||
		!passwordMatches(password, env.ADMIN_PASSWORD)
	) {
		return { error: "invalid_password" };
	}

	const jar = await cookies();
	jar.set(adminCookieName, await signAdminCookie(env.AUTH_SECRET), {
		httpOnly: true,
		sameSite: "lax",
		secure: env.NODE_ENV === "production",
		path: "/",
		maxAge: adminCookieTtlSeconds,
	});
	redirect("/admin");
}
