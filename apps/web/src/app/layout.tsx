import "~/styles/globals.css";

import type { Metadata } from "next";
import {
	Atkinson_Hyperlegible,
	Barlow_Condensed,
	Inter,
} from "next/font/google";

import { LocaleToggle } from "~/app/_components/locale-toggle";
import { getDictionary } from "~/lib/i18n";
import { getRequestLocale } from "~/lib/i18n/server";
import { TRPCReactProvider } from "~/trpc/react";

export async function generateMetadata(): Promise<Metadata> {
	return {
		title: "Tower of Babbage",
		description: getDictionary(await getRequestLocale()).siteDescription,
	};
}

const barlow = Barlow_Condensed({
	subsets: ["latin"],
	weight: "700",
	variable: "--font-barlow-condensed",
});
const inter = Inter({
	subsets: ["latin"],
	variable: "--font-inter",
});
const atkinson = Atkinson_Hyperlegible({
	subsets: ["latin"],
	weight: ["400", "700"],
	variable: "--font-atkinson-hyperlegible",
});

export default async function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	const locale = await getRequestLocale();
	const copy = getDictionary(locale);

	return (
		<html
			className={`${barlow.variable} ${inter.variable} ${atkinson.variable}`}
			lang={locale}
		>
			<body className="min-h-screen bg-ink-950 font-sans text-ink-100">
				<TRPCReactProvider>
					<header className="border-ink-700 border-b bg-ink-800">
						<div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
							<span className="flex items-center gap-3 font-display text-2xl uppercase tracking-wide">
								<svg
									aria-hidden="true"
									className="h-8 w-8 shrink-0"
									viewBox="0 0 32 32"
								>
									<rect
										className="fill-yellow"
										height="4"
										rx="2"
										width="8"
										x="12"
										y="2"
									/>
									<rect
										className="fill-orange"
										height="4"
										rx="2"
										width="14"
										x="9"
										y="8"
									/>
									<rect
										className="fill-green"
										height="4"
										rx="2"
										width="20"
										x="6"
										y="14"
									/>
									<rect
										className="fill-cyan"
										height="4"
										rx="2"
										width="26"
										x="3"
										y="20"
									/>
									<rect
										className="fill-violet"
										height="4"
										rx="2"
										width="32"
										x="0"
										y="26"
									/>
								</svg>
								Tower of Babbage
							</span>
							<LocaleToggle label={copy.localeLabel} locale={locale} />
						</div>
					</header>
					{children}
				</TRPCReactProvider>
			</body>
		</html>
	);
}
