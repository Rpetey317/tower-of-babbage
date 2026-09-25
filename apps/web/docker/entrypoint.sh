#!/bin/sh
# Applies database migrations, then starts the standalone Next.js server.
set -e

node /app/migrate/migrate.mjs
exec node server.js
