import { type NextRequest, NextResponse } from "next/server";

import { adminCookieName, verifyAdminCookie } from "~/lib/auth/admin-cookie";
import { isLocale, resolveLocale } from "~/lib/i18n/locale";

export async function middleware(request: NextRequest) {
	const pathname = request.nextUrl.pathname;

	// Admin gate: every /admin page except the login form needs a valid
	// tob_admin cookie. AUTH_SECRET is read raw (not via ~/env, whose Zod
	// refinements use Buffer, unavailable in the edge runtime).
	if (pathname.startsWith("/admin") && pathname !== "/admin/login") {
		const value = request.cookies.get(adminCookieName)?.value;
		const secret = process.env.AUTH_SECRET;
		if (
			typeof secret !== "string" ||
			!(await verifyAdminCookie(value, secret))
		) {
			return NextResponse.redirect(new URL("/admin/login", request.url));
		}
	}

	const queryLocale = request.nextUrl.searchParams.get("hl");
	const locale = resolveLocale(
		queryLocale,
		request.cookies.get("tob_locale")?.value,
		request.headers.get("accept-language"),
		isLocale(process.env.NEXT_PUBLIC_DEFAULT_LOCALE)
			? process.env.NEXT_PUBLIC_DEFAULT_LOCALE
			: "es",
	);

	const headers = new Headers(request.headers);
	headers.set("x-tob-locale", locale);
	// Lets the root layout strip site chrome on the OBS overlay route.
	headers.set("x-tob-pathname", pathname);
	const response = NextResponse.next({ request: { headers } });
	if (isLocale(queryLocale)) {
		response.cookies.set("tob_locale", locale, {
			httpOnly: false,
			sameSite: "lax",
			path: "/",
			maxAge: 60 * 60 * 24 * 365,
		});
	}
	return response;
}

export const config = {
	matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
