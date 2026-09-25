import type { sessions } from "~/server/db/schema";

/**
 * Demo `file_replay` sessions replaying the audio fixtures under the
 * pipeline's `FIXTURES_DIR`. Shared by `pnpm db:seed` and the
 * `admin.sessions.createDemo` mutation behind the "Create demo sessions"
 * button on an empty dashboard.
 */
export const demoSessions: (typeof sessions.$inferInsert)[] = [
	{
		slug: "demo-en",
		title: "English replay demo",
		room: "Sala A",
		roomColor: "violet",
		sourceLanguage: "en",
		targetLanguages: ["es"],
		sourceType: "file_replay",
		sourceConfig: { path: "en-kubernetes-60s.wav", loop: false },
	},
	{
		slug: "demo-es",
		title: "Demo de repetición en español",
		room: "Sala B",
		roomColor: "cyan",
		sourceLanguage: "es",
		targetLanguages: ["en"],
		sourceType: "file_replay",
		sourceConfig: { path: "es-charla-60s.wav", loop: false },
	},
	{
		slug: "demo-video",
		title: "Video replay demo",
		room: "Sala C",
		roomColor: "green",
		sourceLanguage: "en",
		targetLanguages: ["es"],
		sourceType: "file_replay",
		sourceConfig: { path: "en-kubernetes-60s.mp4", loop: false },
	},
];
