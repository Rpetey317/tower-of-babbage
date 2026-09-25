// Applies Drizzle migrations before the standalone Next.js server starts
// (docker-entrypoint.sh). Development uses `pnpm db:push` instead. Retries
// briefly because Postgres can still be initializing when its healthcheck
// first passes.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error("migrate: DATABASE_URL is not set");
	process.exit(1);
}

const migrationsFolder =
	process.env.MIGRATIONS_DIR ??
	new URL("../apps/web/drizzle/", import.meta.url).pathname;

const attempts = 15;
for (let attempt = 1; attempt <= attempts; attempt++) {
	const client = postgres(databaseUrl, { max: 1 });
	try {
		await migrate(drizzle(client), { migrationsFolder });
		await client.end();
		console.log("migrate: schema up to date");
		process.exit(0);
	} catch (error) {
		await client.end().catch(() => {});
		if (attempt === attempts) throw error;
		console.warn(
			`migrate: attempt ${attempt}/${attempts} failed (${error.code ?? error.message}); retrying`,
		);
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}
