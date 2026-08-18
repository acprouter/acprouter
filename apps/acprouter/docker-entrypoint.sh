#!/bin/sh
# Runs real drizzle migrations against a real Postgres before the server
# starts, when the operator has pointed this deployment at one via
# PG_DATABASE_URL (see docker-compose.yml + README "Deploying it for
# real"). Skipped for the pglite:// default — PGLite migrates itself on
# first connection (packages/acprouter-core/src/db/index.ts's
# `initPglite`), and a file-based embedded db has no separate "migrate"
# step to run here.
set -e

case "${PG_DATABASE_URL:-}" in
  pglite://* | "")
    echo "[acprouter] no real PG_DATABASE_URL set — skipping drizzle-kit migrate (PGLite self-migrates on first connection)."
    ;;
  *)
    echo "[acprouter] PG_DATABASE_URL points at a real Postgres — running drizzle-kit migrate..."
    (cd /app/apps/acprouter && node_modules/.bin/drizzle-kit migrate)
    echo "[acprouter] migrations complete."
    ;;
esac

exec "$@"
