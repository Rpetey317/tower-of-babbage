# syntax=docker/dockerfile:1
# Next.js standalone image for the web app. Build context is the repository
# root (the pnpm lockfile and workspace config live there):
#   docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY apps/web ./apps/web
WORKDIR /app/apps/web
# Validation runs against real env at server start; these are build-time only.
ENV SKIP_ENV_VALIDATION=1
ARG NEXT_PUBLIC_PIPELINE_WS_URL=ws://localhost:8090
ARG NEXT_PUBLIC_DEFAULT_LOCALE=es
ENV NEXT_PUBLIC_PIPELINE_WS_URL=$NEXT_PUBLIC_PIPELINE_WS_URL \
    NEXT_PUBLIC_DEFAULT_LOCALE=$NEXT_PUBLIC_DEFAULT_LOCALE
RUN pnpm build

# Standalone output does not trace drizzle-orm's migrator entry point, so the
# two packages the migration runner needs are copied into a dedicated dir.
FROM deps AS migrate-deps
RUN mkdir -p /migrate/node_modules \
    && cp -rL apps/web/node_modules/drizzle-orm apps/web/node_modules/postgres /migrate/node_modules/

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY apps/web/drizzle ./apps/web/drizzle
COPY apps/web/docker/migrate.mjs ./migrate/migrate.mjs
COPY --from=migrate-deps /migrate/node_modules ./migrate/node_modules
COPY apps/web/docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
USER node
EXPOSE 3000
WORKDIR /app/apps/web
ENTRYPOINT ["sh", "/app/entrypoint.sh"]
