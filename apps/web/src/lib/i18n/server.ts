import "server-only";

import { headers } from "next/headers";

import { isLocale, type Locale } from "./locale";

export async function getRequestLocale(): Promise<Locale> {
	const locale = (await headers()).get("x-tob-locale");
	return isLocale(locale) ? locale : "es";
}
