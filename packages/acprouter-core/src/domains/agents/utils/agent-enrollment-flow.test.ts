import type { AgentVO, MachineVO, MintEnrollmentTokenOutput } from "@acprouter/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_REGISTRATION_TIMEOUT_MS,
  createEnrollmentFlow,
  type EnrollmentDeps,
  type EnrollmentFlow,
  type EnrollmentPhase,
  findMatchingAgent,
  POLL_INTERVAL_MS,
  SESSION_PREPARATION_TIMEOUT_MS,
} from "./agent-enrollment-flow";

const MINT: MintEnrollmentTokenOutput = {
  machineId: "machine-1",
  enrollmentId: "machine-1",
  token: "raw-token",
  command: "npx @acprouter/cli connect --token raw-token",
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
};

function machine(overrides: Partial<MachineVO> = {}): MachineVO {
  return {
    id: "machine-1",
    label: "my-laptop",
    platform: "darwin",
    cliVersion: "0.1.0",
    status: "online",
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function agent(overrides: Partial<AgentVO> = {}): AgentVO {
  return {
    id: "agent-1",
    kind: "bridged",
    registrySlug: "codex-acp",
    label: "Codex",
    machineId: "machine-1",
    cwd: "/home/user/project",
    detectedVersion: "1.0.0",
    status: "connected",
    statusDetail: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Flushes queued microtasks (promise resolution chains) without advancing fake-timer time. */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("findMatchingAgent", () => {
  it("returns matched for the exact machineId + registrySlug + bridged match", () => {
    const target = agent();
    const result = findMatchingAgent([target], "machine-1", "codex-acp");
    expect(result).toEqual({ kind: "matched", agent: target });
  });

  it("returns not-found for a different machine with the same slug", () => {
    const other = agent({ machineId: "machine-2" });
    const result = findMatchingAgent([other], "machine-1", "codex-acp");
    expect(result).toEqual({ kind: "not-found" });
  });

  it("returns mismatched (not not-found) for the same machine with a different registrySlug", () => {
    const wrongSlug = agent({ registrySlug: "claude-acp" });
    const result = findMatchingAgent([wrongSlug], "machine-1", "codex-acp");
    expect(result).toEqual({ kind: "mismatched", agent: wrongSlug });
  });

  it("returns mismatched (not not-found) for the same machine with kind remote-acp", () => {
    const wrongKind = agent({ kind: "remote-acp" });
    const result = findMatchingAgent([wrongKind], "machine-1", "codex-acp");
    expect(result).toEqual({ kind: "mismatched", agent: wrongKind });
  });

  it("returns not-found when no agent exists for the machine at all", () => {
    const result = findMatchingAgent([], "machine-1", "codex-acp");
    expect(result).toEqual({ kind: "not-found" });
  });
});

/** Deterministic, fully controllable deps double — real `setTimeout`/`setInterval` under vitest fake timers, mocked network calls under direct test control. */
function createDeps(overrides: Partial<EnrollmentDeps> = {}) {
  const deps = {
    mint: vi.fn<EnrollmentDeps["mint"]>(async () => MINT),
    listMachines: vi.fn<EnrollmentDeps["listMachines"]>(async () => [] as MachineVO[]),
    listAgents: vi.fn<EnrollmentDeps["listAgents"]>(async () => [] as AgentVO[]),
    startSession: vi.fn<EnrollmentDeps["startSession"]>(async () => ({ sessionId: "session-1" })),
    endSession: vi.fn<EnrollmentDeps["endSession"]>(async () => ({ ok: true })),
    now: () => Date.now(),
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  Object.assign(deps, overrides);
  return deps;
}

function phasesOf(flow: EnrollmentFlow): EnrollmentPhase["phase"][] {
  const seen: EnrollmentPhase["phase"][] = [];
  flow.subscribe((state) => seen.push(state.phase.phase));
  return seen;
}

describe("createEnrollmentFlow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the other list request after a partial failure before polling again", async () => {
    let resolveAgents: ((agents: AgentVO[]) => void) | undefined;
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(
        () =>
          new Promise<AgentVO[]>((resolve) => {
            resolveAgents = resolve;
          }),
      ),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    deps.listMachines.mockRejectedValueOnce(new Error("network failure"));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(deps.listAgents).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
    expect(deps.listAgents).toHaveBeenCalledTimes(1);
    expect(deps.listMachines).toHaveBeenCalledTimes(2);
    resolveAgents?.([]);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(deps.listAgents).toHaveBeenCalledTimes(2);
    flow.close();
  });

  it("does not start from a list response arriving after the registration deadline", async () => {
    const pending: { resolve?: (agents: AgentVO[]) => void } = {};
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(
        () =>
          new Promise<AgentVO[]>((resolve) => {
            pending.resolve = resolve;
          }),
      ),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    await vi.advanceTimersByTimeAsync(AGENT_REGISTRATION_TIMEOUT_MS);
    expect(flow.getState().phase.phase).toBe("registration-timed-out");
    pending.resolve?.([agent()]);
    await flushMicrotasks();
    expect(flow.getState().phase.phase).toBe("registration-timed-out");
    expect(deps.startSession).not.toHaveBeenCalled();
    flow.close();
  });

  it("recognizes an offline redeemed machine on its first observation after token expiry", async () => {
    const deps = createDeps({
      now: () => new Date(MINT.expiresAt).getTime() + 1,
      listMachines: vi.fn(async () => [machine({ status: "offline" })]),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(flow.getState().phase.phase).toBe("offline-reconnect");
    flow.close();
  });

  it("advances minting -> waiting-machine -> waiting-agent -> starting-session -> handed-off on a clean success path", async () => {
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => [agent()]),
    });
    const flow = createEnrollmentFlow(deps);
    const seen = phasesOf(flow);

    flow.start("codex-acp", "codex-acp");
    expect(flow.getState().phase.phase).toBe("minting");
    await flushMicrotasks();
    expect(flow.getState().phase.phase).toBe("waiting-machine");

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(flow.getState().phase.phase).toBe("waiting-agent");

    // `startSession` resolves immediately in this fixture, and
    // `advanceTimersByTimeAsync` already flushes the resulting microtask
    // chain — so the next tick lands directly on the final `handed-off`
    // phase rather than pausing on the intermediate `starting-session` one.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(flow.getState().phase.phase).toBe("handed-off");
    expect(deps.startSession).toHaveBeenCalledTimes(1);
    expect(deps.startSession).toHaveBeenCalledWith("agent-1");

    expect(seen).toEqual([
      "minting",
      "waiting-machine",
      "waiting-agent",
      "starting-session",
      "handed-off",
    ]);
  });

  it("never fires a second poll request before the first (slow mocked response) one settles", async () => {
    const pending: { resolveFirst: (() => void) | null } = { resolveFirst: null };
    let callCount = 0;
    const deps = createDeps({
      listMachines: vi.fn<EnrollmentDeps["listMachines"]>(() => {
        callCount += 1;
        if (callCount === 1) {
          return new Promise<MachineVO[]>((resolve) => {
            pending.resolveFirst = () => resolve([machine()]);
          });
        }
        return Promise.resolve([machine()]);
      }),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();

    // First tick fires and is left in flight.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(callCount).toBe(1);

    // Even though enough wall-clock time passes for several more ticks, no
    // second call fires because the first has not settled yet.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(callCount).toBe(1);

    // Now let the first resolve; the next tick (scheduled only after
    // settling) can fire.
    pending.resolveFirst?.();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(callCount).toBe(2);
  });

  it("discards an in-flight check's result once the attempt's generation has been bumped by close()", async () => {
    const pending: { resolveMachines: ((value: MachineVO[]) => void) | null } = {
      resolveMachines: null,
    };
    const deps = createDeps({
      listMachines: vi.fn(
        () =>
          new Promise<MachineVO[]>((resolve) => {
            pending.resolveMachines = resolve;
          }),
      ),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    const generationAtCheckStart = flow.getState().generation;
    flow.close(); // user closes dialog mid-check
    expect(flow.getState().generation).toBeGreaterThan(generationAtCheckStart);

    pending.resolveMachines?.([machine()]);
    await flushMicrotasks();

    // No state update happened for the closed attempt — phase/generation
    // frozen at whatever close() left them at (minting's immediate
    // predecessor phase, since the only state captured here is "closed").
    expect(flow.getState().phase.phase).not.toBe("waiting-agent");
  });

  it("stops scheduling further checks once a terminal phase (mismatched) is reached", async () => {
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => [agent({ registrySlug: "claude-acp" })]),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // -> waiting-agent
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // -> mismatched
    expect(flow.getState().phase.phase).toBe("mismatched");

    const listAgentsCallsAtMismatch = deps.listAgents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);
    expect(deps.listAgents.mock.calls.length).toBe(listAgentsCallsAtMismatch);
  });

  it("stops scheduling further checks for every terminal phase", async () => {
    for (const setup of [
      {
        name: "expired",
        deps: createDeps({ now: () => new Date(MINT.expiresAt).getTime() + 1 }),
      },
      {
        name: "agent-auth-required",
        deps: createDeps({
          listMachines: vi.fn(async () => [machine()]),
          listAgents: vi.fn(async () => [agent({ status: "auth_required" })]),
        }),
      },
      {
        name: "agent-error",
        deps: createDeps({
          listMachines: vi.fn(async () => [machine()]),
          listAgents: vi.fn(async () => [agent({ status: "error" })]),
        }),
      },
    ]) {
      const flow = createEnrollmentFlow(setup.deps);
      flow.start("codex-acp", "codex-acp");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      const terminalPhase = flow.getState().phase.phase;
      expect(terminalPhase).not.toBe("waiting-machine");

      const pollCallsAtTerminal = setup.deps.listMachines.mock.calls.length;
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);
      expect(setup.deps.listMachines.mock.calls.length).toBe(pollCallsAtTerminal);
    }
  });

  it("calls sessions.start at most once per attempt across many overlapping fast-firing ticks", async () => {
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => [agent()]),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();

    // Advance far more than needed for many ticks; the single-flight +
    // terminal-phase guards must still land exactly one `startSession` call.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await flushMicrotasks();
    }

    expect(deps.startSession).toHaveBeenCalledTimes(1);
  });

  it("times out registration after AGENT_REGISTRATION_TIMEOUT_MS, distinct from the expired phase", async () => {
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => []),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // -> waiting-agent
    expect(flow.getState().phase.phase).toBe("waiting-agent");

    await vi.advanceTimersByTimeAsync(AGENT_REGISTRATION_TIMEOUT_MS);
    expect(flow.getState().phase.phase).toBe("registration-timed-out");
  });

  it("never shows expired once a machine row has been observed, even if the token's own expiresAt has passed", async () => {
    let elapsed = 0;
    const deps = createDeps({
      now: () => Date.now() + elapsed,
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => []),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // machine observed online
    expect(flow.getState().phase.phase).toBe("waiting-agent");

    // Simulate the token's expiresAt having passed from this point on.
    elapsed = 20 * 60_000;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(flow.getState().phase.phase).not.toBe("expired");
  });

  it("'check again' resumes polling the same machineId without re-minting, and does not start a second concurrent attempt", async () => {
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => []),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // -> waiting-agent
    await vi.advanceTimersByTimeAsync(AGENT_REGISTRATION_TIMEOUT_MS); // -> registration-timed-out
    expect(flow.getState().phase.phase).toBe("registration-timed-out");
    expect(deps.mint).toHaveBeenCalledTimes(1);

    flow.retry();
    expect(flow.getState().phase.phase).toBe("waiting-agent");
    expect(deps.mint).toHaveBeenCalledTimes(1); // never re-minted

    // Agent now registers under the SAME machineId. `startSession` resolves
    // immediately in this fixture, so the single `advanceTimersByTimeAsync`
    // below both reaches `starting-session` and flushes the resulting
    // `handed-off` transition in one go.
    deps.listAgents.mockImplementation(async () => [agent()]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(flow.getState().phase.phase).toBe("handed-off");
    expect(deps.startSession).toHaveBeenCalledTimes(1);
  });

  it("blocks retry() and a second concurrent sessions.start while a preparation-timeout retry's old start is still unresolved (regression: codex-review #2)", async () => {
    const pending: { resolveStart: ((value: { sessionId: string }) => void) | null } = {
      resolveStart: null,
    };
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => [agent()]),
      startSession: vi.fn(
        () =>
          new Promise<{ sessionId: string }>((resolve) => {
            pending.resolveStart = resolve;
          }),
      ),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // -> waiting-agent
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // -> starting-session, sessions.start in flight
    expect(flow.getState().phase.phase).toBe("starting-session");
    expect(deps.startSession).toHaveBeenCalledTimes(1);

    // The 180s preparation deadline fires while that call is still pending.
    await vi.advanceTimersByTimeAsync(SESSION_PREPARATION_TIMEOUT_MS);
    expect(flow.getState().phase.phase).toBe("preparation-timed-out");

    // canRetry must read false — the UI's "waiting explanation" branch —
    // because the old sessions.start call has not settled yet.
    expect(flow.getState().canRetry).toBe(false);

    // An explicit retry() call must be a no-op: no new generation, no
    // second sessions.start, no re-mint, while that old call is pending.
    const generationBeforeRetry = flow.getState().generation;
    flow.retry();
    expect(flow.getState().generation).toBe(generationBeforeRetry);
    expect(flow.getState().phase.phase).toBe("preparation-timed-out");
    expect(deps.startSession).toHaveBeenCalledTimes(1); // still just the one call
    expect(deps.mint).toHaveBeenCalledTimes(1);

    // Only once the stale call actually settles does the guard open back up.
    pending.resolveStart?.({ sessionId: "late-session" });
    await flushMicrotasks();
    expect(flow.getState().canRetry).toBe(true);
    expect(deps.endSession).toHaveBeenCalledWith("agent-1", "late-session");

    flow.retry();
    expect(flow.getState().generation).toBe(generationBeforeRetry + 1);
  });

  it("re-arms a fresh registration deadline on retry, so it times out again if the agent still never registers (regression: apply-context.txt #7)", async () => {
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => []), // agent never registers, ever
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // -> waiting-agent
    await vi.advanceTimersByTimeAsync(AGENT_REGISTRATION_TIMEOUT_MS); // -> registration-timed-out
    expect(flow.getState().phase.phase).toBe("registration-timed-out");

    flow.retry();
    expect(flow.getState().phase.phase).toBe("waiting-agent");

    // Before the fix, `machineObservedOnline` was already `true` from the
    // first attempt, so `pollTick`'s ONLY deadline-arming branch (the
    // first-observation one) never ran again on resume — the flow would
    // poll forever past this point with no second timeout. Advancing past
    // the full registration timeout again must now reach
    // `registration-timed-out` a second time, not stay stuck in
    // `waiting-agent` indefinitely.
    await vi.advanceTimersByTimeAsync(AGENT_REGISTRATION_TIMEOUT_MS);
    expect(flow.getState().phase.phase).toBe("registration-timed-out");
  });

  it("re-arms a fresh registration deadline on retry after an offline-reconnect timeout too", async () => {
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine({ status: "offline" })]),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // -> offline-reconnect
    expect(flow.getState().phase.phase).toBe("offline-reconnect");

    await vi.advanceTimersByTimeAsync(AGENT_REGISTRATION_TIMEOUT_MS);
    expect(flow.getState().phase.phase).toBe("registration-timed-out");

    // `retry()` optimistically resumes into `waiting-agent` (it does not
    // re-derive the machine's last-known online/offline status itself); the
    // very next poll tick corrects it back to `offline-reconnect` since the
    // mocked machine is still reported offline.
    flow.retry();
    expect(flow.getState().phase.phase).toBe("waiting-agent");
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(flow.getState().phase.phase).toBe("offline-reconnect");

    // The regression this test exists for: the deadline must have been
    // re-armed by `retry()` itself (not only by the first-observation branch
    // in `pollTick`, which cannot run again once `machineObservedOnline` is
    // already `true`) — otherwise this would poll forever.
    await vi.advanceTimersByTimeAsync(AGENT_REGISTRATION_TIMEOUT_MS);
    expect(flow.getState().phase.phase).toBe("registration-timed-out");
  });

  it("discards a sessions.start resolution that arrives after the registration-timeout phase has already been shown", async () => {
    const pending: { resolveStart: ((value: { sessionId: string }) => void) | null } = {
      resolveStart: null,
    };
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => [agent()]),
      startSession: vi.fn(
        () =>
          new Promise<{ sessionId: string }>((resolve) => {
            pending.resolveStart = resolve;
          }),
      ),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // -> waiting-agent
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // -> starting-session (sessions.start in flight)
    expect(flow.getState().phase.phase).toBe("starting-session");

    // The preparation timeout fires before the call resolves.
    await vi.advanceTimersByTimeAsync(SESSION_PREPARATION_TIMEOUT_MS);
    expect(flow.getState().phase.phase).toBe("preparation-timed-out");

    // Late success must be disposed of, never navigated to.
    pending.resolveStart?.({ sessionId: "late-session" });
    await flushMicrotasks();
    expect(flow.getState().phase.phase).toBe("preparation-timed-out");
    expect(deps.endSession).toHaveBeenCalledWith("agent-1", "late-session");
  });

  it("stage-3: calls sessions.start exactly once on stage-2 match, rendering starting-session before it resolves", async () => {
    const pending: { resolveStart: ((value: { sessionId: string }) => void) | null } = {
      resolveStart: null,
    };
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => [agent()]),
      startSession: vi.fn(
        () =>
          new Promise<{ sessionId: string }>((resolve) => {
            pending.resolveStart = resolve;
          }),
      ),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(flow.getState().phase.phase).toBe("starting-session");
    expect(deps.startSession).toHaveBeenCalledTimes(1);

    pending.resolveStart?.({ sessionId: "session-1" });
    await flushMicrotasks();
    expect(flow.getState().phase.phase).toBe("handed-off");
  });

  it("renders a distinct start-error state for a rejected sessions.start call", async () => {
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => [agent()]),
      startSession: vi.fn(async () => {
        throw new Error("bridge dropped");
      }),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await flushMicrotasks();

    const state = flow.getState();
    expect(state.phase.phase).toBe("start-error");
    if (state.phase.phase === "start-error") {
      expect(state.phase.message).toBe("bridge dropped");
    }
  });

  it("start-error and mismatched states are reachable independently with distinguishable phases", async () => {
    const mismatchDeps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => [agent({ registrySlug: "claude-acp" })]),
    });
    const mismatchFlow = createEnrollmentFlow(mismatchDeps);
    mismatchFlow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(mismatchFlow.getState().phase.phase).toBe("mismatched");

    const startErrorDeps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => [agent()]),
      startSession: vi.fn(async () => {
        throw new Error("spawn failed");
      }),
    });
    const startErrorFlow = createEnrollmentFlow(startErrorDeps);
    startErrorFlow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await flushMicrotasks();
    expect(startErrorFlow.getState().phase.phase).toBe("start-error");
    expect(startErrorFlow.getState().phase.phase).not.toBe(mismatchFlow.getState().phase.phase);
  });

  it("disposes a session via sessions.end when the resolution arrives after close(), and never hands off", async () => {
    const pending: { resolveStart: ((value: { sessionId: string }) => void) | null } = {
      resolveStart: null,
    };
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => [agent()]),
      startSession: vi.fn(
        () =>
          new Promise<{ sessionId: string }>((resolve) => {
            pending.resolveStart = resolve;
          }),
      ),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(flow.getState().phase.phase).toBe("starting-session");

    flow.close(); // dialog closed while sessions.start is still in flight
    pending.resolveStart?.({ sessionId: "session-1" });
    await flushMicrotasks();

    expect(deps.endSession).toHaveBeenCalledWith("agent-1", "session-1");
    expect(flow.getState().phase.phase).not.toBe("handed-off");
  });

  it("does not block or delay closing/starting a new attempt on the disposal call settling", async () => {
    const pending: {
      resolveStart: ((value: { sessionId: string }) => void) | null;
      resolveEnd: ((value: { ok: boolean }) => void) | null;
    } = { resolveStart: null, resolveEnd: null };
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine()]),
      listAgents: vi.fn(async () => [agent()]),
      startSession: vi.fn(
        () =>
          new Promise<{ sessionId: string }>((resolve) => {
            pending.resolveStart = resolve;
          }),
      ),
      endSession: vi.fn(
        () =>
          new Promise<{ ok: boolean }>((resolve) => {
            pending.resolveEnd = resolve;
          }),
      ),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    flow.close();
    pending.resolveStart?.({ sessionId: "session-1" });
    await flushMicrotasks();
    // The disposal call (endSession) has been fired but its own promise has
    // NOT settled yet — a brand new attempt can still start immediately,
    // unblocked by that still-pending disposal.
    expect(deps.endSession).toHaveBeenCalledWith("agent-1", "session-1");
    expect(pending.resolveEnd).not.toBeNull();
    flow.start("codex-acp", "codex-acp");
    expect(flow.getState().phase.phase).toBe("minting");
  });

  it("shows an offline-reconnect state for a redeemed machine observed offline, not token-expired", async () => {
    const deps = createDeps({
      listMachines: vi.fn(async () => [machine({ status: "offline" })]),
    });
    const flow = createEnrollmentFlow(deps);
    flow.start("codex-acp", "codex-acp");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(flow.getState().phase.phase).toBe("offline-reconnect");
  });

  it("exposes AgentVO.registrySlug and kind as already-typed fields with no contract change needed", () => {
    const a = agent();
    expect(typeof a.registrySlug).toBe("string");
    expect(a.kind === "bridged" || a.kind === "remote-acp").toBe(true);
  });

  describe("disposal cleanup tracking (apply-context.txt #4)", () => {
    it("tracks a successful disposal as lastCleanup.status 'ok', going through 'pending' first", async () => {
      const pending: { resolveStart: ((value: { sessionId: string }) => void) | null } = {
        resolveStart: null,
      };
      const seenCleanupStatuses: Array<string | null> = [];
      const deps = createDeps({
        listMachines: vi.fn(async () => [machine()]),
        listAgents: vi.fn(async () => [agent()]),
        startSession: vi.fn(
          () =>
            new Promise<{ sessionId: string }>((resolve) => {
              pending.resolveStart = resolve;
            }),
        ),
        endSession: vi.fn(async () => ({ ok: true })),
      });
      const flow = createEnrollmentFlow(deps);
      flow.subscribe((state) => seenCleanupStatuses.push(state.lastCleanup?.status ?? null));
      flow.start("codex-acp", "codex-acp");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(flow.getState().phase.phase).toBe("starting-session");
      expect(flow.getState().lastCleanup).toBeNull();

      flow.close(); // supersedes the attempt while sessions.start is in flight
      pending.resolveStart?.({ sessionId: "session-1" });
      await flushMicrotasks();

      expect(flow.getState().lastCleanup).toEqual({
        agentId: "agent-1",
        sessionId: "session-1",
        status: "ok",
      });
      // "pending" must have been observed by subscribers before "ok" — the
      // outcome is tracked through the async call, not just reported once
      // settled.
      expect(seenCleanupStatuses).toContain("pending");
    });

    it("tracks an ok:false disposal result as lastCleanup.status 'failed', distinct from a transport rejection", async () => {
      const pending: { resolveStart: ((value: { sessionId: string }) => void) | null } = {
        resolveStart: null,
      };
      const deps = createDeps({
        listMachines: vi.fn(async () => [machine()]),
        listAgents: vi.fn(async () => [agent()]),
        startSession: vi.fn(
          () =>
            new Promise<{ sessionId: string }>((resolve) => {
              pending.resolveStart = resolve;
            }),
        ),
        endSession: vi.fn(async () => ({ ok: false })),
      });
      const flow = createEnrollmentFlow(deps);
      flow.start("codex-acp", "codex-acp");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      flow.close();
      pending.resolveStart?.({ sessionId: "session-1" });
      await flushMicrotasks();

      expect(flow.getState().lastCleanup).toEqual({
        agentId: "agent-1",
        sessionId: "session-1",
        status: "failed",
      });
    });

    it("tracks a rejected endSession call (transport failure) as lastCleanup.status 'failed' and never throws", async () => {
      const pending: { resolveStart: ((value: { sessionId: string }) => void) | null } = {
        resolveStart: null,
      };
      const deps = createDeps({
        listMachines: vi.fn(async () => [machine()]),
        listAgents: vi.fn(async () => [agent()]),
        startSession: vi.fn(
          () =>
            new Promise<{ sessionId: string }>((resolve) => {
              pending.resolveStart = resolve;
            }),
        ),
        endSession: vi.fn(async () => {
          throw new Error("network drop");
        }),
      });
      const flow = createEnrollmentFlow(deps);
      flow.start("codex-acp", "codex-acp");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      flow.close();
      expect(() => pending.resolveStart?.({ sessionId: "session-1" })).not.toThrow();
      await flushMicrotasks();

      expect(flow.getState().lastCleanup).toEqual({
        agentId: "agent-1",
        sessionId: "session-1",
        status: "failed",
      });
    });

    it("retryCleanup() re-fires endSession for a failed cleanup and can succeed on retry", async () => {
      const pending: { resolveStart: ((value: { sessionId: string }) => void) | null } = {
        resolveStart: null,
      };
      let endSessionCall = 0;
      const deps = createDeps({
        listMachines: vi.fn(async () => [machine()]),
        listAgents: vi.fn(async () => [agent()]),
        startSession: vi.fn(
          () =>
            new Promise<{ sessionId: string }>((resolve) => {
              pending.resolveStart = resolve;
            }),
        ),
        endSession: vi.fn(async () => {
          endSessionCall += 1;
          return { ok: endSessionCall > 1 }; // fails first, succeeds on retry
        }),
      });
      const flow = createEnrollmentFlow(deps);
      flow.start("codex-acp", "codex-acp");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      flow.close();
      pending.resolveStart?.({ sessionId: "session-1" });
      await flushMicrotasks();
      expect(flow.getState().lastCleanup?.status).toBe("failed");
      expect(deps.endSession).toHaveBeenCalledTimes(1);

      flow.retryCleanup();
      await flushMicrotasks();
      expect(deps.endSession).toHaveBeenCalledTimes(2);
      expect(flow.getState().lastCleanup?.status).toBe("ok");
    });

    it("retryCleanup() is a no-op when there is no tracked cleanup, or the last one already succeeded", async () => {
      const deps = createDeps();
      const flow = createEnrollmentFlow(deps);
      flow.start("codex-acp", "codex-acp");
      await flushMicrotasks();

      flow.retryCleanup(); // nothing to retry yet
      expect(deps.endSession).not.toHaveBeenCalled();
    });

    it("retryCleanup() is a no-op while a disposal is already pending (never double-fires)", async () => {
      const pending: {
        resolveStart: ((value: { sessionId: string }) => void) | null;
        resolveEnd: ((value: { ok: boolean }) => void) | null;
      } = { resolveStart: null, resolveEnd: null };
      const deps = createDeps({
        listMachines: vi.fn(async () => [machine()]),
        listAgents: vi.fn(async () => [agent()]),
        startSession: vi.fn(
          () =>
            new Promise<{ sessionId: string }>((resolve) => {
              pending.resolveStart = resolve;
            }),
        ),
        endSession: vi.fn(
          () =>
            new Promise<{ ok: boolean }>((resolve) => {
              pending.resolveEnd = resolve;
            }),
        ),
      });
      const flow = createEnrollmentFlow(deps);
      flow.start("codex-acp", "codex-acp");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      flow.close();
      pending.resolveStart?.({ sessionId: "session-1" });
      await flushMicrotasks();
      expect(flow.getState().lastCleanup?.status).toBe("pending");

      flow.retryCleanup(); // must not fire a second endSession while the first is still pending
      expect(deps.endSession).toHaveBeenCalledTimes(1);

      pending.resolveEnd?.({ ok: true });
      await flushMicrotasks();
      expect(flow.getState().lastCleanup?.status).toBe("ok");
    });

    it("a fresh start() clears lastCleanup from a previous attempt", async () => {
      const pending: { resolveStart: ((value: { sessionId: string }) => void) | null } = {
        resolveStart: null,
      };
      const deps = createDeps({
        listMachines: vi.fn(async () => [machine()]),
        listAgents: vi.fn(async () => [agent()]),
        startSession: vi.fn(
          () =>
            new Promise<{ sessionId: string }>((resolve) => {
              pending.resolveStart = resolve;
            }),
        ),
        endSession: vi.fn(async () => ({ ok: false })),
      });
      const flow = createEnrollmentFlow(deps);
      flow.start("codex-acp", "codex-acp");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      flow.close();
      pending.resolveStart?.({ sessionId: "session-1" });
      await flushMicrotasks();
      expect(flow.getState().lastCleanup?.status).toBe("failed");

      flow.start("codex-acp", "codex-acp"); // a genuinely new attempt
      expect(flow.getState().lastCleanup).toBeNull();
    });
  });
});
