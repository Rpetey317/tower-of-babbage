import Link from "next/link";

import { getDictionary } from "~/lib/i18n";
import { getRequestLocale } from "~/lib/i18n/server";

import { SessionForm } from "../../_components/session-form";

export default async function NewSessionPage() {
	const copy = getDictionary(await getRequestLocale());
	return (
		<main className="mx-auto max-w-6xl px-4 py-12">
			<Link className="text-cyan text-sm hover:underline" href="/admin">
				← {copy.adminBackToList}
			</Link>
			<h1 className="mt-4 font-display text-4xl uppercase tracking-wide">
				{copy.adminCreateTitle}
			</h1>
			<SessionForm
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
				mode="create"
			/>
		</main>
	);
}
