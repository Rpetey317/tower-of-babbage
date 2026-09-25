import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { PlaybackView } from "~/app/(audience)/_components/playback-view";
import { resolveCaptionView } from "~/lib/captions";
import { getRequestLocale } from "~/lib/i18n/server";
import { videoMediaPath } from "~/lib/playback";
import { createCaller } from "~/server/api/root";
import { db } from "~/server/db";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

async function sessionBySlug(slug: string) {
	const caller = createCaller({ db, headers: await headers() });
	try {
		return await caller.sessions.bySlug({ slug });
	} catch (error) {
		if (error instanceof TRPCError && error.code === "NOT_FOUND") {
			notFound();
		}
		throw error;
	}
}

export async function generateMetadata({
	params,
}: {
	params: Promise<{ slug: string }>;
}): Promise<Metadata> {
	const { slug } = await params;
	const session = await sessionBySlug(slug).catch(() => null);
	return { title: session ? `${session.title} — Tower of Babbage` : undefined };
}

export default async function PlaybackPage({
	params,
	searchParams,
}: {
	params: Promise<{ slug: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const [{ slug }, query] = await Promise.all([params, searchParams]);
	const session = await sessionBySlug(slug);
	const view = resolveCaptionView({
		sourceLanguage: session.sourceLanguage,
		targetLanguages: session.targetLanguages,
		lang: first(query.lang),
		mode: first(query.mode),
	});
	// Subscribe to every session language so switching does not refetch.
	const languages = [
		...new Set([session.sourceLanguage, ...session.targetLanguages]),
	];
	const caller = createCaller({ db, headers: await headers() });
	const initialSegments = await caller.segments.recent({
		sessionId: session.id,
		languages,
		limit: 200,
	});
	const locale = await getRequestLocale();
	const mediaUrl = videoMediaPath(session)
		? `/api/media/${session.slug}`
		: null;

	return (
		<PlaybackView
			initialLanguage={view.language}
			initialMode={view.mode}
			initialSegments={initialSegments}
			locale={locale}
			mediaUrl={mediaUrl}
			session={session}
		/>
	);
}
