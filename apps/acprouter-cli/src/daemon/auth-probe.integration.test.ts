import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SpawnSpec } from "./agent-distribution";
import { probeAgentAuth } from "./auth-probe";

const FIXTURE_PATH = fileURLToPath(new URL("./__fixtures__/fake-auth-agent.mjs", import.meta.url));
const FAKE_SLUG = "fake-auth-agent";

/**
 * Real-child-process rigor, same tier as `bridge-agent.integration.test.ts`
 * (task #8) and its `fake-stdio-agent.mjs`: a real Node process is spawned,
 * real newline-delimited JSON-RPC crosses real stdio pipes, and (for the
 * terminal case) a real *second* process is spawned with real inherited
 * stdio. What's NOT real here, per the task's own verification split: an
 * actual browser OAuth flow and an actual interactive terminal TUI — both
 * require a human, which this environment doesn't have. `fake-auth-agent.mjs`
 * simulates both deterministically (see its own doc comment for the exact
 * knobs); the "no auth needed" path is instead verified for real against the
 * actual installed `claude`/`codex` binaries, exercised separately.
 */
describe("probeAgentAuth", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(methods: unknown[]) {
    dir = mkdtempSync(join(tmpdir(), "acprouter-auth-probe-test-"));
    const stateFile = join(dir, "state");
    const methodsFile = join(dir, "methods.json");
    writeFileSync(methodsFile, JSON.stringify(methods));
    return { stateFile, methodsFile };
  }

  function resolveDistribution(extraArgs: string[]): (slug: string) => SpawnSpec | null {
    return (slug) =>
      slug === FAKE_SLUG ? { command: process.execPath, args: [FIXTURE_PATH, ...extraArgs] } : null;
  }

  it("reports ok when session/new succeeds without ever hitting auth_required", async () => {
    const { stateFile, methodsFile } = setup([]);
    writeFileSync(stateFile, "pre-authenticated\n"); // already "logged in" before the probe runs
    const result = await probeAgentAuth({
      registrySlug: FAKE_SLUG,
      dir,
      resolveDistribution: resolveDistribution([
        `--state-file=${stateFile}`,
        `--methods-file=${methodsFile}`,
      ]),
    });
    expect(result).toEqual({ state: "ok" });
  });

  it("drives terminal auth: relaunches with the method's extra args/env (inherited stdio), then re-probes to ok", async () => {
    const { stateFile, methodsFile } = setup([
      {
        id: "term1",
        name: "Terminal Login",
        type: "terminal",
        args: ["--login"],
        env: { FAKE_TERMINAL_ENV_MARKER: "env-was-passed" },
      },
    ]);
    const result = await probeAgentAuth({
      registrySlug: FAKE_SLUG,
      dir,
      resolveDistribution: resolveDistribution([
        `--state-file=${stateFile}`,
        `--methods-file=${methodsFile}`,
      ]),
    });
    expect(result).toEqual({ state: "ok" });
    // Proof the relaunch actually happened with the method's args AND env,
    // not just that the probe claims success — the fixture only writes this
    // exact marker from its `--login` branch.
    expect(readFileSync(stateFile, "utf8")).toBe("env-was-passed\n");
  });

  it("terminal auth that doesn't complete (still not authenticated after relaunch) is reported as sign_in_needed, not ok or a crash", async () => {
    const { stateFile, methodsFile } = setup([
      { id: "term1", name: "Terminal Login", type: "terminal", args: ["--login", "--login-fail"] },
    ]);
    const result = await probeAgentAuth({
      registrySlug: FAKE_SLUG,
      dir,
      resolveDistribution: resolveDistribution([
        `--state-file=${stateFile}`,
        `--methods-file=${methodsFile}`,
      ]),
    });
    expect(result.state).toBe("sign_in_needed");
    expect((result as { detail: string }).detail).toContain("did not complete");
  });

  it("drives agent (browser) auth: calls authenticate over the same connection, then re-probes to ok", async () => {
    const { stateFile, methodsFile } = setup([{ id: "agent1", name: "Browser Login" }]);
    const result = await probeAgentAuth({
      registrySlug: FAKE_SLUG,
      dir,
      resolveDistribution: resolveDistribution([
        `--state-file=${stateFile}`,
        `--methods-file=${methodsFile}`,
        "--auth-mode=succeed",
      ]),
    });
    expect(result).toEqual({ state: "ok" });
  });

  it("agent auth that never responds times out (bounded, does not hang) and reports sign_in_needed", async () => {
    const { stateFile, methodsFile } = setup([{ id: "agent1", name: "Browser Login" }]);
    const result = await probeAgentAuth({
      registrySlug: FAKE_SLUG,
      dir,
      resolveDistribution: resolveDistribution([
        `--state-file=${stateFile}`,
        `--methods-file=${methodsFile}`,
        "--auth-mode=hang",
      ]),
      agentAuthTimeoutMs: 200,
    });
    expect(result.state).toBe("sign_in_needed");
    expect((result as { detail: string }).detail).toContain("timed out");
  });

  it("agent auth that errors is still reported as sign_in_needed, not a crash", async () => {
    const { stateFile, methodsFile } = setup([{ id: "agent1", name: "Browser Login" }]);
    const result = await probeAgentAuth({
      registrySlug: FAKE_SLUG,
      dir,
      resolveDistribution: resolveDistribution([
        `--state-file=${stateFile}`,
        `--methods-file=${methodsFile}`,
        "--auth-mode=fail",
      ]),
    });
    expect(result.state).toBe("sign_in_needed");
    expect((result as { detail: string }).detail).toContain("did not complete");
  });

  it("env_var-only methods are reported, never driven interactively", async () => {
    const { stateFile, methodsFile } = setup([
      {
        id: "env1",
        name: "API Key",
        type: "env_var",
        vars: [{ name: "FOO_API_KEY", label: "Foo API Key" }],
        link: "https://example.com/keys",
      },
    ]);
    const result = await probeAgentAuth({
      registrySlug: FAKE_SLUG,
      dir,
      resolveDistribution: resolveDistribution([
        `--state-file=${stateFile}`,
        `--methods-file=${methodsFile}`,
      ]),
    });
    expect(result.state).toBe("sign_in_needed");
    const detail = (result as { detail: string }).detail;
    expect(detail).toContain("FOO_API_KEY");
    expect(detail).toContain("https://example.com/keys");
  });

  it("auth_required with no authMethods advertised at all does not crash", async () => {
    const { stateFile, methodsFile } = setup([]);
    const result = await probeAgentAuth({
      registrySlug: FAKE_SLUG,
      dir,
      resolveDistribution: resolveDistribution([
        `--state-file=${stateFile}`,
        `--methods-file=${methodsFile}`,
      ]),
    });
    expect(result.state).toBe("sign_in_needed");
    expect((result as { detail: string }).detail).toContain("did not report");
  });

  it("a non-auth_required session/new failure is a genuine error, not misclassified as sign-in needed", async () => {
    const { stateFile, methodsFile } = setup([]);
    const result = await probeAgentAuth({
      registrySlug: FAKE_SLUG,
      dir,
      resolveDistribution: resolveDistribution([
        `--state-file=${stateFile}`,
        `--methods-file=${methodsFile}`,
        "--session-error=-32603",
      ]),
    });
    expect(result.state).toBe("probe_failed");
  });

  it("an unresolvable registry slug fails closed as probe_failed", async () => {
    dir = mkdtempSync(join(tmpdir(), "acprouter-auth-probe-test-"));
    const result = await probeAgentAuth({
      registrySlug: "not-a-real-slug",
      dir,
      resolveDistribution: () => null,
    });
    expect(result.state).toBe("probe_failed");
  });
});
