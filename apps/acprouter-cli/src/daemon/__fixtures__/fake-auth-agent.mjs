// A minimal, honest ACP agent over stdio — the "real child process" half of
// `auth-probe.integration.test.ts` (task #9's own tier-2 fixture, parallel to
// `fake-stdio-agent.mjs` from task #8). Deliberately hand-rolled JSON-RPC,
// same reasoning as that file: stands in for a real ACP agent that demands
// sign-in, without the cost/nondeterminism of a real OAuth flow.
//
// Controlled entirely by CLI args (not env vars) so `auth-probe.ts`'s own
// `resolveDistribution` override can bake per-test behavior straight into
// the spawn spec, the same way `bridge-agent.integration.test.ts` does:
//
//   --state-file=<path>    Existence of this file means "authenticated".
//                           `session/new` succeeds iff it exists.
//   --methods-file=<path>  JSON array of AuthMethod objects `initialize`
//                           reports as `authMethods`.
//   --login                This IS a terminal-auth relaunch (inherited
//                           stdio, no ACP spoken at all — matches
//                           `AuthMethodTerminal`'s real shape): touch the
//                           state file, then exit immediately. `--login-fail`
//                           skips the touch, simulating a login that didn't
//                           complete.
//   --auth-mode=<mode>     How the `authenticate` RPC (the `agent`-method
//                           flow) behaves: "succeed" touches the state file
//                           and resolves; "fail" rejects; "hang" never
//                           responds (used for the timeout test, paired with
//                           a short `agentAuthTimeoutMs` override).
//   --session-error=<code> Makes `session/new` always fail with this JSON-RPC
//                           code (ignoring the state file) — simulates a
//                           genuine, non-auth crash so the probe's
//                           `probe_failed` path (not `sign_in_needed`) can be
//                           proven for real.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
function argValue(prefix) {
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const stateFile = argValue("--state-file=");
const methodsFile = argValue("--methods-file=");
const authMode = argValue("--auth-mode=") ?? "succeed";
const sessionErrorCode = argValue("--session-error=");

if (args.includes("--login")) {
  // Writes the env var `driveTerminalAuth` is supposed to have merged in
  // from `AuthMethodTerminal.env`, not just a fixed string — proof the
  // relaunch actually carried the method's extra env, not only its args.
  if (!args.includes("--login-fail") && stateFile) {
    writeFileSync(stateFile, `${process.env.FAKE_TERMINAL_ENV_MARKER ?? "authenticated"}\n`);
  }
  process.exit(0);
}

const authMethods =
  methodsFile && existsSync(methodsFile) ? JSON.parse(readFileSync(methodsFile, "utf8")) : [];

const rl = createInterface({ input: process.stdin, terminal: false });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  const message = JSON.parse(text);

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods },
    });
    return;
  }

  if (message.method === "session/new") {
    if (sessionErrorCode) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: Number(sessionErrorCode), message: "simulated crash" },
      });
      return;
    }
    if (stateFile && existsSync(stateFile)) {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "sess_fake_auth_1" } });
    } else {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "Authentication required" },
      });
    }
    return;
  }

  if (message.method === "authenticate") {
    if (authMode === "hang") return; // never respond — the timeout test's whole point.
    if (authMode === "fail") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "sign-in failed" },
      });
      return;
    }
    if (stateFile) writeFileSync(stateFile, "authenticated\n");
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
});
