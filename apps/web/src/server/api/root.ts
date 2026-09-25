import { segmentsRouter } from "~/server/api/routers/segments";
import { sessionsRouter } from "~/server/api/routers/sessions";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

import { adminRouter } from "./routers/admin";

export const appRouter = createTRPCRouter({
	sessions: sessionsRouter,
	segments: segmentsRouter,
	admin: adminRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
