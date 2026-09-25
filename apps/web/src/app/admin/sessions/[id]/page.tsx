import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getDictionary } from "~/lib/i18n";
import { getRequestLocale } from "~/lib/i18n/server";
import { db } from "~/server/db";
import { sessionEvents, sessions } from "~/server/db/schema";

import { ExportLinks } from "../../_components/export-links";
import { SessionActions } from "../../_components/session-actions";
import { SessionEventsLog } from "../../_components/session-events-log";
import {
	SessionForm,
	type SessionFormValues,
} from "../../_components/session-form";
import { StatusPill } from "../../_components/status-pill";

export const dynamic = "force-dynamic";

export default async function SessionPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const copy = getDictionary(await getRequestLocale());
	const { id } = await params;
	const [session] = await db.select().from(sessions).where(eq(sessions.id, id));
	if (!session) notFound();

	const events = await db
		.select()
		.from(sessionEvents)
		.where(eq(sessionEvents.sessionId, session.id))
		.orderBy(desc(sessionEvents.createdAt), desc(sessionEvents.id))
		.limit(100);

	const initial: SessionFormValues = {
		title: session.title,
		slug: session.slug,
		room: session.room,
		roomColor: session.roomColor,
		sourceLanguage: session.sourceLanguage,
		targetLanguages: session.targetLanguages,
		sourceType: session.sourceType,
		sourceConfig: session.sourceConfig as Record<string, unknown>,
		translationMode: session.translationMode,
	};

	return (
		<main className="mx-auto max-w-6xl px-4 py-12">
			<Link className="text-cyan text-sm hover:underline" href="/admin">
				← {copy.adminBackToList}
			</Link>
			<div className="mt-4 flex items-center gap-4">
				<h1 className="font-display text-4xl uppercase tracking-wide">
					{session.title}
				</h1>
				<StatusPill copy={copy} status={session.status} />
			</div>
			<div className="mt-4 flex items-center gap-4">
				<SessionActions
					labels={{
						start: copy.adminStart,
						stop: copy.adminStop,
						stopping: copy.adminStatusStopping,
					}}
					sessionId={session.id}
					status={session.status}
				/>
				<Link
					className="text-cyan text-sm hover:underline"
					href={`/s/${session.slug}`}
				>
					{copy.adminViewAudience}
				</Link>
				<Link
					className="text-cyan text-sm hover:underline"
					href={`/admin/sessions/${session.id}/operator`}
				>
					{copy.adminViewOperator}
				</Link>
			</div>
			{session.lastError && (
				<p className="mt-4 text-coral text-sm">
					{copy.adminColLastError}: {session.lastError}
				</p>
			)}
			<h2 className="mt-8 font-display text-2xl uppercase tracking-wide">
				{copy.adminExportTitle}
			</h2>
			<ExportLinks
				languages={[
					...new Set([session.sourceLanguage, ...session.targetLanguages]),
				]}
				sessionId={session.id}
			/>
			<h2 className="mt-8 font-display text-2xl uppercase tracking-wide">
				{copy.adminEditTitle}
			</h2>
			<SessionForm
				initial={initial}
				labels={{
					title: copy.adminFieldTitle,
					slug: copy.adminFieldSlug,
					room: copy.adminFieldRoom,
					roomColor: copy.adminFieldRoomColor,
					sourceLanguage: copy.adminFieldSourceLanguage,
					targetLanguages: copy.adminFieldTargetLanguages,
					sourceType: copy.adminFieldSourceType,
					replayPath: copy.adminFieldReplayPath,
					replayLoop: copy.adminFieldReplayLoop,
					streamUrl: copy.adminFieldStreamUrl,
					deviceName: copy.adminFieldDeviceName,
					deviceBackend: copy.adminFieldDeviceBackend,
					browserMicHint: copy.adminFieldBrowserMicHint,
					targetAdd: copy.adminTargetAdd,
					targetMoveUp: copy.adminTargetMoveUp,
					targetMoveDown: copy.adminTargetMoveDown,
					targetRemove: copy.adminTargetRemove,
					translationMode: copy.adminFieldTranslationMode,
					createSubmit: copy.adminCreateSubmit,
					saveSubmit: copy.adminSaveSubmit,
					formError: copy.adminFormError,
					delete: copy.adminDelete,
					deleteConfirm: copy.adminDeleteConfirm,
				}}
				mode="edit"
				sessionId={session.id}
			/>
			<SessionEventsLog
				copy={copy}
				initialEvents={events}
				sessionId={session.id}
			/>
		</main>
	);
}
