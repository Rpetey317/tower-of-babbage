/**
 * Demo seed: two `file_replay` sessions replaying the audio fixtures under the
 * pipeline's `FIXTURES_DIR`. Idempotent; re-running leaves the database
 * unchanged.
 *
 * Run with `pnpm db:seed` after `make db-push`.
 */
import { db } from "~/server/db";
import { sessions } from "~/server/db/schema";

const demoSessions: (typeof sessions.$inferInsert)[] = [
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
];

async function main() {
	const inserted = await db
		.insert(sessions)
		.values([...demoSessions])
		.onConflictDoNothing({ target: sessions.slug })
		.returning({ slug: sessions.slug });

	if (inserted.length > 0) {
		console.log(`Seeded sessions: ${inserted.map((s) => s.slug).join(", ")}`);
	} else {
		console.log("Demo sessions already present, nothing to do.");
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
