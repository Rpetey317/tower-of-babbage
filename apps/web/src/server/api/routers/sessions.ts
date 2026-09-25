import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { sessions } from "~/server/db/schema";

const sessionColumns = {
	id: sessions.id,
	slug: sessions.slug,
	title: sessions.title,
	room: sessions.room,
	roomColor: sessions.roomColor,
	sourceLanguage: sessions.sourceLanguage,
	targetLanguages: sessions.targetLanguages,
	status: sessions.status,
};

export const sessionsRouter = createTRPCRouter({
	list: publicProcedure.query(() =>
		db.select(sessionColumns).from(sessions).orderBy(asc(sessions.createdAt)),
	),

	bySlug: publicProcedure
		.input(z.object({ slug: z.string().min(1) }))
		.query(async ({ input }) => {
			const [session] = await db
				.select(sessionColumns)
				.from(sessions)
				.where(eq(sessions.slug, input.slug))
				.limit(1);
			if (!session) {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
			return session;
		}),
});
