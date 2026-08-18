import { spawn } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import type { AuthStatus } from "../config";
import { resolveAgentDistribution, type SpawnSpec } from "./agent-distribution";
import { closeSpawnedAgent, type SpawnedAgent, spawnAndInitializeAgent } from "./agent-spawn";

export interface AuthProbeOptions {
  registrySlug: string;
  dir: string;
  log?: (line: string) => void;
  resolveDistribution?: (registrySlug: string) => SpawnSpec | null;
  /**
   * A real interactive `agent`-method sign-in is an actual browser OAuth
   * flow the user has to click through — there's no protocol-mandated
   * number, so 4 minutes is chosen as generous enough for a real human to
   * finish one without risking `connect` hanging forever if they never do
   * (same "never hang, always have a stated timeout" principle spec
   * §3/§5.5a applies to unanswered permission requests). Overridable so
   * tests don't wait for real.
   */
  agentAuthTimeoutMs?: number;
}

const DEFAULT_AGENT_AUTH_TIMEOUT_MS = 4 * 60 * 1000;
const AUTH_REQUIRED_CODE = acp.RequestError.authRequired().code;

function isAuthRequiredError(error: unknown): boolean {
  return error instanceof acp.RequestError && error.code === AUTH_REQUIRED_CODE;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function attemptSessionNew(
  inner: acp.ClientConnection,
  dir: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await inner.agent.request(acp.methods.agent.session.new, {
      cwd: dir,
      additionalDirectories: [],
      mcpServers: [],
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function methodType(method: acp.AuthMethod): "terminal" | "env_var" | "agent" {
  if ("type" in method) {
    if (method.type === "terminal") return "terminal";
    if (method.type === "env_var") return "env_var";
  }
  return "agent";
}

/**
 * Preference order is `terminal` → `agent` → `env_var` (spec §5.2a point 2:
 * "`terminal` auth needs a terminal — the user has one open — they just
 * pasted a command into it", making it the most direct path at connect
 * time; `agent`/browser is next-most-direct since the browser opens on this
 * same machine; `env_var` can't be driven interactively at all, so it is
 * always last and only ever reported, never attempted).
 */
function selectAuthMethod(
  methods: acp.AuthMethod[],
):
  | { type: "terminal"; method: acp.AuthMethodTerminal }
  | { type: "agent"; method: acp.AuthMethodAgent }
  | { type: "env_var"; method: acp.AuthMethodEnvVar }
  | null {
  const terminal = methods.find((m) => methodType(m) === "terminal");
  if (terminal) return { type: "terminal", method: terminal as acp.AuthMethodTerminal };
  const agentMethod = methods.find((m) => methodType(m) === "agent");
  if (agentMethod) return { type: "agent", method: agentMethod as acp.AuthMethodAgent };
  const envVar = methods.find((m) => methodType(m) === "env_var");
  if (envVar) return { type: "env_var", method: envVar as acp.AuthMethodEnvVar };
  return null;
}

function describeEnvVarMethod(registrySlug: string, method: acp.AuthMethodEnvVar): string {
  const names = method.vars.map((v) => (v.label ? `${v.name} (${v.label})` : v.name)).join(", ");
  const link = method.link ? ` See ${method.link}.` : "";
  return `${registrySlug} needs ${names} set in your shell before it can sign in.${link} Set ${
    method.vars.length > 1 ? "them" : "it"
  }, then run "acprouter connect" again.`;
}

function noMethodsDetail(registrySlug: string): string {
  return `${registrySlug} requires sign-in but did not report how to sign in during initialize. Sign in using ${registrySlug}'s own CLI directly, then run "acprouter connect" again.`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function driveAgentAuth(
  options: AuthProbeOptions,
  spawned: SpawnedAgent,
  method: acp.AuthMethodAgent,
  log: (line: string) => void,
): Promise<AuthStatus> {
  const timeoutMs = options.agentAuthTimeoutMs ?? DEFAULT_AGENT_AUTH_TIMEOUT_MS;
  log(
    `${options.registrySlug} needs sign-in ("${method.name}"). It should open your browser — check it now.`,
  );
  try {
    await withTimeout(
      spawned.inner.agent.request(acp.methods.agent.authenticate, { methodId: method.id }),
      timeoutMs,
      `sign-in via "${method.name}" timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
  } catch (error) {
    await closeSpawnedAgent(spawned);
    return {
      state: "sign_in_needed",
      detail: `Sign-in via "${method.name}" did not complete: ${describeError(error)}. Run "acprouter connect" again once you've finished signing in.`,
    };
  }

  const retry = await attemptSessionNew(spawned.inner, options.dir);
  await closeSpawnedAgent(spawned);
  if (retry.ok) return { state: "ok" };
  return {
    state: "sign_in_needed",
    detail: `Signed in via "${method.name}" but ${options.registrySlug} still isn't authenticated. Run "acprouter connect" again after finishing sign-in.`,
  };
}

async function driveTerminalAuth(
  options: AuthProbeOptions,
  resolveDistribution: (registrySlug: string) => SpawnSpec | null,
  method: acp.AuthMethodTerminal,
  log: (line: string) => void,
): Promise<AuthStatus> {
  const spawnSpec = resolveDistribution(options.registrySlug);
  if (!spawnSpec) {
    // Can't actually happen (this slug was just resolved to get this far) —
    // fails closed rather than assuming the lookup is still there.
    return {
      state: "sign_in_needed",
      detail: `Could not resolve ${options.registrySlug}'s distribution to relaunch it for terminal sign-in.`,
    };
  }

  log(
    `${options.registrySlug} needs sign-in ("${method.name}"). Launching an interactive terminal — follow its prompts.`,
  );
  const args = [...spawnSpec.args, ...(method.args ?? [])];
  const env = { ...process.env, ...(method.env ?? {}) };

  const exit = await new Promise<{ error?: Error }>((resolve) => {
    // Inherited stdio, not piped — this run IS the user's terminal login,
    // not another ACP session (spec §5.2a point 2 / AuthMethodTerminal doc:
    // "the client runs an interactive terminal for the user to authenticate
    // via a TUI").
    const child = spawn(spawnSpec.command, args, { cwd: options.dir, stdio: "inherit", env });
    child.once("error", (error) => resolve({ error }));
    child.once("exit", () => resolve({}));
  });

  if (exit.error) {
    return {
      state: "sign_in_needed",
      detail: `Could not launch ${options.registrySlug} for terminal sign-in: ${exit.error.message}`,
    };
  }

  let spawned: SpawnedAgent;
  try {
    spawned = await spawnAndInitializeAgent({
      registrySlug: options.registrySlug,
      dir: options.dir,
      log,
      resolveDistribution,
    });
  } catch (error) {
    return {
      state: "probe_failed",
      detail: `Terminal sign-in finished but re-checking ${options.registrySlug} failed: ${describeError(error)}`,
    };
  }

  const retry = await attemptSessionNew(spawned.inner, options.dir);
  await closeSpawnedAgent(spawned);
  if (retry.ok) return { state: "ok" };
  return {
    state: "sign_in_needed",
    detail: `Terminal sign-in for ${options.registrySlug} did not complete (still not authenticated). Run "acprouter connect" again after finishing sign-in.`,
  };
}

/**
 * The connect-time probe itself (spec §5.2a point 2 / acceptance criterion
 * 10): spawn the agent, attempt a real `session/new`, and if it fails with
 * `auth_required` drive whichever auth method is most direct at a terminal
 * the user is already sitting at. Never throws — every failure mode
 * (unresolvable slug, spawn crash, auth method failure/timeout, no methods
 * advertised) resolves to a status the caller can persist and print, and
 * every subprocess/connection this function opens is closed on every exit
 * path before it returns.
 */
export async function probeAgentAuth(options: AuthProbeOptions): Promise<AuthStatus> {
  const log = options.log ?? (() => {});
  const resolveDistribution = options.resolveDistribution ?? resolveAgentDistribution;

  let spawned: SpawnedAgent;
  try {
    spawned = await spawnAndInitializeAgent({
      registrySlug: options.registrySlug,
      dir: options.dir,
      log,
      resolveDistribution,
    });
  } catch (error) {
    return {
      state: "probe_failed",
      detail: `Could not start ${options.registrySlug} to check sign-in status: ${describeError(error)}`,
    };
  }

  const first = await attemptSessionNew(spawned.inner, options.dir);
  if (first.ok) {
    await closeSpawnedAgent(spawned);
    return { state: "ok" };
  }
  if (!isAuthRequiredError(first.error)) {
    await closeSpawnedAgent(spawned);
    return {
      state: "probe_failed",
      detail: `${options.registrySlug} failed to start a session: ${describeError(first.error)}`,
    };
  }

  // Auth is required — from here on this is a first-class flow (spec §5.2a
  // point 1), not an error path, even though it started from a rejection.
  const methods = spawned.initializeResult.authMethods ?? [];
  const selection = selectAuthMethod(methods);

  if (!selection) {
    await closeSpawnedAgent(spawned);
    return { state: "sign_in_needed", detail: noMethodsDetail(options.registrySlug) };
  }

  if (selection.type === "env_var") {
    await closeSpawnedAgent(spawned);
    return {
      state: "sign_in_needed",
      detail: describeEnvVarMethod(options.registrySlug, selection.method),
    };
  }

  if (selection.type === "terminal") {
    // Free the piped stdio child before relaunching with inherited stdio —
    // two processes fighting over the same terminal/registry slug isn't a
    // state this needs to support.
    await closeSpawnedAgent(spawned);
    return driveTerminalAuth(options, resolveDistribution, selection.method, log);
  }

  // "agent" method reuses the SAME already-connected session the
  // `auth_required` came from (spec §5.2a point 2: "call `authenticate` on
  // an already-connected session"), so ownership of `spawned`'s cleanup
  // passes to `driveAgentAuth` from here.
  return driveAgentAuth(options, spawned, selection.method, log);
}
