import { type NextRequest, NextResponse } from "next/server";

import { isLocale, resolveLocale } from "~/lib/i18n/locale";

export function middleware(request: NextRequest) {
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
