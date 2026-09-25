import { TRPCError } from "@trpc/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { OverlayView } from "~/app/overlay/_components/overlay-view";
import { resolveOverlayParams } from "~/lib/overlay";
import { createCaller } from "~/server/api/root";
import { db } from "~/server/db";

export const dynamic = "force-dynamic";

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

export default async function OverlayPage({
	params,
	searchParams,
}: {
	params: Promise<{ slug: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const [{ slug }, query] = await Promise.all([params, searchParams]);
	const session = await sessionBySlug(slug);
	const overlay = resolveOverlayParams({
		query,
		sourceLanguage: session.sourceLanguage,
		targetLanguages: session.targetLanguages,
	});
	const live = session.status === "running" || session.status === "starting";
	const initialSegments = live
		? await createCaller({ db, headers: await headers() }).segments.recent({
				sessionId: session.id,
				languages: overlay.languages,
				limit: 50,
			})
		: [];

	return (
		<OverlayView
			initialSegments={initialSegments}
			params={overlay}
			session={session}
		/>
	);
}
