# ACP Router

ACP Router is a server with a public address that your local AI coding agents (Claude Code, Codex) dial
*out* to — so a laptop with no public IP and no open ports becomes something the browser, your team, or
another product can reach and drive over [ACP](https://agentclientprotocol.com).

## This app has no login — read this before you deploy it anywhere

**The OSS edition ships with no authentication or user accounts, on purpose** (spec §8.1 — the same call
`apps/busabase` makes). That is a *safe* choice on `localhost`, because nothing outside your own machine can
reach it. It stops being safe the moment this app is reachable from anywhere else: **anyone who can reach a
Router with no front door can enrol machines against it and drive whatever agents are already connected.**

So, before anything else in this file:

1. **This app binds `127.0.0.1` by default** (`pnpm dev` / `pnpm start` both hardcode `-H 127.0.0.1`).
   Exposing it beyond your own machine is something *you* have to do on purpose — it is never the default.
2. **If you do expose it, put a real front door in front of it first.** Pick one:
   - A **reverse proxy with basic auth or SSO** (Caddy, nginx, Cloudflare Access, Tailscale Funnel with
     access controls, …) — the [Docker Compose example](#deploying-it-for-real) below is exactly this,
     runnable as-is.
   - A **private network** — Tailscale, WireGuard, a VPN, or any network your machines are already on that
     the public internet is not.
   - A **firewall rule** restricting inbound access to addresses you trust.
3. **The dashboard will tell on you if you skip this.** If the Router is reachable from a non-loopback
   address with no proxy credential configured, every page shows a persistent banner naming the exposure.
   Once you really do have a reverse proxy (or private network) in front of it, set
   `ACPROUTER_TRUST_REVERSE_PROXY=true` so the banner stops nagging — that env var is the one honest way to
   tell the app "I did the thing," not a way to make the warning go away without doing it.
4. **Enrollment tokens are single-use and short-lived.** A leaked one (pasted into a chat window, a
   screenshot, a shared terminal) is worthless the moment it's redeemed once or it expires — but that is a
   mitigation, not a substitute for the front door above.

What this buys you if you skip all of the above anyway and put it directly on a public IP: nothing catches
you. There is no login page, no rate limiter, no IP allowlist built in. **A Router with a public address and
no front door is an open relay into every machine enrolled against it.** Do not do that.

## Local development (no Docker, no setup)

```bash
pnpm --filter @acprouter/server dev
```

Opens on `http://127.0.0.1:15420`. No database to install and nothing to configure — it boots against an
embedded [PGLite](https://pglite.dev) instance at `.data/acprouter` and migrates itself on first run. Land
directly on the dashboard; there's no login screen, because there is no login in this edition (see above).

## Connecting an agent

Sidebar → **Agents** → **Add** → *Claude Code* or *Codex*. The dialog shows a one-line command:

```bash
npx @acprouter/cli connect --server http://<router> --token <one-time>
```

Run it on the machine where the agent is installed (not on the Router's own machine, unless they're the
same box). The CLI detects the agent, drives sign-in if the agent demands one, and holds an outbound
connection back to the Router — no port forwarding, no inbound firewall rule needed on that machine. The
card in the dashboard goes green once it's connected, showing the detected version and working directory.

`npx @acprouter/cli --help` documents the rest of the CLI surface (`status`, `restart`, `stop`, `logs`,
`agents ls`) — see `apps/acprouter-cli/package.json`'s description for what it is: the local bridge that
makes the connect command above work.

*Buda* agents (already ACP-native over WebSocket) skip the CLI entirely — the Add dialog just takes an
endpoint and an API key.

## Connecting Zed or JetBrains

Neither has a URL-based agent config, only `Custom{command,args,env}` and `Registry{env}` — so
`apps/acprouter-acp` (`@acprouter/acp`) is a small stdio shim that speaks ACP to the editor on one side
and ACP-over-WebSocket to the Router on the other. Configure it as a custom agent:

- `command`: `npx`, `args`: `["@acprouter/acp", "--agent", "<agentId>", "--server", "http://<router>"]`
- `env`: `{ "ACPROUTER_API_KEY": "<ack_...>" }` — the key belongs in `env`, not `args`; anything in
  `args` is visible to anything that can list this machine's processes.

The editor then talks to it exactly like any other local ACP agent, unaware it's actually a bridge to
the Router.

## Deploying it for real

The reference deployment is a **Docker Compose stack with the proxy built in, not bolted on** —
`docker-compose.yml` in this directory, alongside `Dockerfile` and `docker/Caddyfile`:

```
        published :18089                 internal compose network only
 host ───────────────▶  proxy (Caddy)  ───────────────▶  acprouter  ───────────────▶  postgres
                        basic auth                        no published port          no published port
```

- **`proxy` is the only service with a published port.** It terminates basic auth (Caddy's `basic_auth`
  directive) before anything reaches the Router.
- **`acprouter` and `postgres` publish no `ports:` to the host at all.** They are reachable only from
  other containers on the compose file's `internal` network. This — Docker Compose's network isolation,
  not any bind address inside either container — is what actually keeps them off the public internet. See
  the "why not `127.0.0.1` inside the container" note below; it trips people up.
- **`acprouter` is configured with `ACPROUTER_TRUST_REVERSE_PROXY=true`**, because in this topology a real
  proxy really is in front of it — the example demonstrates the complete, correct picture, not just the
  proxy in isolation.
- **A real Postgres, not the dev-only embedded PGLite.** PGLite is a single-process, file-based, embedded
  database — great for zero-setup local dev, a poor fit for a real deployment (no separate backup story, no
  separate scaling, and it corrupts if more than one process touches its data directory at once). The
  compose stack points `PG_DATABASE_URL` at a real `postgres:16-alpine` service, and the container's
  startup runs real `drizzle-kit migrate` against it before the server starts (see `docker-entrypoint.sh`)
  — the schema is actually there, not just assumed.

### Run it

```bash
cp apps/acprouter/.env.example apps/acprouter/.env
# edit apps/acprouter/.env: set a real POSTGRES_PASSWORD and a real CADDY_BASIC_AUTH_HASH
# (generate the hash with: docker run --rm caddy:2-alpine caddy hash-password --plaintext '<your password>')

docker compose -f apps/acprouter/docker-compose.yml --env-file apps/acprouter/.env up --build
```

Then, from the host:

```bash
# No credentials → rejected by the proxy, never reaches the Router.
curl -i http://localhost:18089/

# Real credentials → reaches the real Router.
curl -i -u "$CADDY_BASIC_AUTH_USER:<your plaintext password>" http://localhost:18089/

# The Router's own port is NOT reachable directly from the host — this must fail to connect.
curl http://localhost:15420/
```

### Why `127.0.0.1` binding is the bare-metal answer but *not* the Docker one

`package.json`'s `start` script hardcodes `next start -H 127.0.0.1` — that's real and correct for a
**bare-metal or systemd deployment**, where "bind loopback" genuinely means "nothing off this machine can
reach it," and exposing it deliberately means changing that flag or putting a real proxy in front on the
same host.

Inside Docker, "bind loopback" stops meaning that. **Each container has its own network namespace.** A
container's `127.0.0.1` is only reachable from *inside that same container* — not from a sibling container,
not from the host, not from anywhere else — with or without Docker in the picture. So binding the Router to
`127.0.0.1` *inside its own container* would not add any protection (nothing outside that container could
ever have reached it anyway) and would actively break the one thing that's supposed to reach it on purpose:
the `proxy` container, over the compose network. That's why this image's runtime stage deliberately does
**not** override `HOSTNAME` (Next's standalone `server.js` already defaults to `0.0.0.0`, i.e. every
interface inside its own container) — see the comment in `Dockerfile`'s runtime stage.

The real front door in the Docker topology is `docker-compose.yml` simply never publishing a `ports:`
mapping for `acprouter` (or `postgres`) to the host. If you `docker run -p 15420:15420` this image directly,
outside Compose, you've made exposing it an explicit act again — consistent with, not a violation of, the
principle above.

### Kubernetes

No manifests ship in this repo yet. The same principle applies unchanged: put a real ingress/reverse proxy
with real auth in front, and never publish the Router's own port (`Service` type `ClusterIP`, not
`LoadBalancer`/`NodePort`, with only the proxy/ingress publicly routable) — the Docker Compose stack above
is the reference to translate from.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PG_DATABASE_URL` | `pglite://.data/acprouter` | Set to a real `postgres://…` URL to use a real Postgres instead of the embedded dev database. |
| `ACPROUTER_TRUST_REVERSE_PROXY` | unset | Set to exactly `true` once a real reverse proxy or private network is in front of this instance, to suppress the exposure banner. |
| `PORT` | `15420` | Port the server listens on. |

## Repository layout

This app
(`apps/acprouter`) is the self-hostable Router; `apps/acprouter-cli` is the local bridge you run on a
machine with an agent on it; `apps/acprouter-acp` is the Zed/JetBrains stdio shim (see above);
`packages/acprouter-core` / `packages/acprouter-contract` are the shared server logic and oRPC contract
both depend on.
