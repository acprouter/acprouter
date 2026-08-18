#################################################################
# ACP Router — self-hostable OSS gateway.                         #
# Multi-stage, Next.js standalone output, with ONE deliberate      #
# divergence from the usual pattern: see the "runtime" stage's    #
# comment on HOSTNAME before touching it.                         #
#################################################################

FROM node:24.18.0-bookworm AS base
ENV PNPM_HOME=/root/.local/share/pnpm \
    PATH=/root/.local/share/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

## ---- deps (lockfile fetch -> offline install) ----
FROM base AS deps
# Step 1: only lock & root manifest for maximum cache reuse
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY patches patches
# `pnpm fetch` downloads the WHOLE monorepo lockfile (thousands of packages
# across all 50+ apps), not just this app's subset — retry on transient
# registry socket timeouts rather than fail the whole build on one flaky
# download; pnpm's content-addressable store means a retry only re-fetches
# what didn't land the first time.
RUN pnpm config set fetch-retries 5 && \
    pnpm config set fetch-retry-maxtimeout 120000 && \
    pnpm config set network-concurrency 8 && \
    for attempt in 1 2 3 4 5; do \
      pnpm fetch && break; \
      echo "pnpm fetch attempt ${attempt} failed, retrying..."; \
      sleep 5; \
    done

# Step 2: add workspace manifests (adding these later avoids breaking fetch cache when source changes)
COPY apps/acprouter/package.json apps/acprouter/
COPY packages/acprouter-core/package.json packages/acprouter-core/
COPY packages/acprouter-contract/package.json packages/acprouter-contract/
COPY packages/kui/package.json packages/kui/
COPY packages/openlib/package.json packages/openlib/
RUN pnpm install --offline --frozen-lockfile --ignore-scripts

# Step 3: bring in source code (only needed workspaces)
COPY packages/kui packages/kui
COPY packages/openlib packages/openlib
COPY packages/acprouter-core packages/acprouter-core
COPY packages/acprouter-contract packages/acprouter-contract
COPY apps/acprouter apps/acprouter

# ---- build ----
FROM deps AS build
ARG BUILD_NUMBER=0
ARG BUILD_SHA=local
ARG BUILD_TIME=local
ENV BUILD_NUMBER=${BUILD_NUMBER}
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_TIME=${BUILD_TIME}
WORKDIR /app/apps/acprouter
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm build

# ---- drizzle minimal stage (for migrations only) ----
FROM base AS drizzle
WORKDIR /drizzle-only
COPY packages/acprouter-core/package.json /tmp/core-package.json
RUN set -e; \
    node -e "require('node:fs').writeFileSync('package.json', JSON.stringify({ private: true }))"; \
    CORE_JSON=/tmp/core-package.json; \
    DRIZZLE_VERSION=$(node -pe "const p=require('$CORE_JSON'); (p.devDependencies?.['drizzle-kit'] || p.dependencies?.['drizzle-kit'] || '').replace(/^[^0-9]*/, '')"); \
    DRIZZLE_ORM_VERSION=$(node -pe "const p=require('$CORE_JSON'); (p.devDependencies?.['drizzle-orm'] || p.dependencies?.['drizzle-orm'] || '').replace(/^[^0-9]*/, '')"); \
    POSTGRES_VERSION=$(node -pe "const p=require('$CORE_JSON'); (p.devDependencies?.postgres || p.dependencies?.postgres || '').replace(/^[^0-9]*/, '')"); \
    pnpm add drizzle-kit@${DRIZZLE_VERSION} drizzle-orm@${DRIZZLE_ORM_VERSION} postgres@${POSTGRES_VERSION} --prod --allow-build=esbuild

# ---- runtime ----
FROM node:24.18.0-bookworm-slim AS runner
ENV NODE_ENV=production \
    PORT=15420 \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0
# HOSTNAME=0.0.0.0 IS set here, explicitly — and it has to be explicit,
# not left to a default, for a subtle reason verified against a real
# container rather than assumed:
#
# apps/acprouter/package.json's own `start` script hardcodes
# `next start -H 127.0.0.1` on purpose (spec §8.1 point 1 — exposing the
# Router must be an explicit act) for the bare-metal/systemd deployment
# path. This standalone server.js is a DIFFERENT code path (`node
# server.js`, not `next start`), and its generated default hostname
# expression is `process.env.HOSTNAME || '0.0.0.0'` — which looks like it
# would fall back to "every interface" if this image left HOSTNAME unset.
# It does NOT: Docker itself auto-injects a `HOSTNAME` environment
# variable into every container, set to that container's own short
# hostname/ID (confirmed with `docker exec <container> env | grep
# HOSTNAME`) — which Docker also makes resolve, via that container's own
# `/etc/hosts`, to the container's specific assigned network IP. Left
# unset, this app's `server.js` therefore picks up Docker's own injected
# value and binds ONLY that one specific IP — not `0.0.0.0`, and, as a
# direct consequence, NOT its own loopback (127.0.0.1) either, which
# silently breaks anything (like this file's own HEALTHCHECK, or `curl
# localhost:15420` run from a shell inside the container) that assumes
# loopback reaches the app. Explicitly setting `HOSTNAME=0.0.0.0` above
# overrides Docker's injected value and restores real "every interface"
# binding — deterministic rather than incidental, and it makes loopback
# work again inside the container.
#
# Binding every interface here is still the correct, safe choice for
# THIS image, same conclusion as before: a sibling container (the reverse
# proxy) can only reach this one over Docker's internal network by its
# service name, and each container has its own network namespace —
# binding to 127.0.0.1 *inside this container* would make it unreachable
# from the proxy container too, without adding any real protection
# (loopback is not "network isolation"; nothing outside this container's
# own namespace could ever reach 127.0.0.1 here regardless of Docker at
# all).
#
# The actual front door for the Docker deployment is docker-compose.yml
# NOT publishing a `ports:` mapping for this service — see that file's
# own comment and apps/acprouter/README.md "Deploying it for real". If
# you `docker run -p 15420:15420` this image directly, outside Compose,
# you have made exposing it an explicit act again (the `-p` flag) —
# consistent with, not a violation of, spec §8.1.
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy standalone output
COPY --from=build /app/apps/acprouter/.next/standalone ./
COPY --from=build /app/apps/acprouter/.next/static ./apps/acprouter/.next/static
COPY --from=build /app/apps/acprouter/drizzle.config.ts ./apps/acprouter/drizzle.config.ts
COPY --from=build /app/apps/acprouter/src/db/migrations ./apps/acprouter/src/db/migrations
COPY --from=drizzle /drizzle-only/node_modules ./apps/acprouter/node_modules
# openlib source is needed by drizzle.config.ts ("openlib/db" import)
COPY --from=build /app/packages/openlib ./packages/openlib
RUN ln -s ../../../packages/openlib apps/acprouter/node_modules/openlib
# acprouter-core source is needed by drizzle.config.ts's `schema:` path
# (a relative file path, not a package import — no symlink required)
COPY --from=build /app/packages/acprouter-core ./packages/acprouter-core

COPY apps/acprouter/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Create non-root user
RUN useradd -r -u 1001 acprouter && chown -R acprouter:acprouter /app
USER acprouter

EXPOSE 15420
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD curl -f http://localhost:15420/ || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "apps/acprouter/server.js"]
