import type { AgentVO, MachineVO, MintEnrollmentTokenOutput } from "@acprouter/contract";

/**
 * Isomorphic, framework-free coordinator for the bridged-agent enrollment
 * flow (PUL-353). `AddAgentDialog` is the only caller; it exists as its own
 * module (not inline in the component) so the single-flight/attempt-
 * generation state machine can be driven deterministically with fake timers
 * in a plain `vitest` node environment, with no React/DOM involved at all.
 *
 * Three readiness stages, per design.md Decision 1:
 *   1. machine online        (`MachineVO.status === "online"`)
 *   2. the specific agent for this attempt registers & authenticates
 *      (`AgentVO` matching machineId + registrySlug + kind==="bridged")
 *   3. `sessions.start({ agentId })` resolves with a real `sessionId`
 *
 * Correlation is never by `machineId` alone (Decision 2) — a mismatch is its
 * own terminal, actionable phase, never silently accepted.
 */

/** Decision 8: measured from the moment the machine is first observed online, never from mint time and never derived from the token's own `expiresAt`. */
export const AGENT_REGISTRATION_TIMEOUT_MS = 120_000;

/** Final Review Clarifications: session preparation (stage 3) gets its own explicit UI deadline, separate from the registration timeout and the token deadline. */
export const SESSION_PREPARATION_TIMEOUT_MS = 180_000;

/** How often each stage's poll re-checks, once scheduled. */
export const POLL_INTERVAL_MS = 2000;

export type AgentMatchResult =
  | { kind: "matched"; agent: AgentVO }
  | { kind: "mismatched"; agent: AgentVO }
  | { kind: "not-found" };

/**
 * Task 1.1: find the one `AgentVO` produced by this enrollment attempt.
 * Correlates on `machineId` AND `registrySlug` AND `kind === "bridged"`
 * together (design.md Decision 2) — never on `machineId` alone, since the
 * `(machineId, registrySlug)` unique index only constrains that pair, not
 * `machineId` in isolation (design.md Context fact 4).
 *
 * - An agent under a *different* machine that happens to share the slug is
 *   excluded by construction (`not-found` for this attempt, not `mismatched`
 *   — it simply isn't a candidate at all).
 * - An agent under the *right* machine but the wrong slug or kind is a
 *   `mismatched` result, distinguishable from "nothing registered yet".
 */
export function findMatchingAgent(
  agents: readonly AgentVO[],
  machineId: string,
  registrySlug: string,
): AgentMatchResult {
  const onThisMachine = agents.filter((agent) => agent.machineId === machineId);
  if (onThisMachine.length === 0) return { kind: "not-found" };

  const matched = onThisMachine.find(
    (agent) => agent.registrySlug === registrySlug && agent.kind === "bridged",
  );
  if (matched) return { kind: "matched", agent: matched };

  return { kind: "mismatched", agent: onThisMachine[0] };
}

export type EnrollmentPhase =
  | { phase: "minting" }
  | { phase: "mint-error"; message: string }
  | { phase: "waiting-machine"; mint: MintEnrollmentTokenOutput }
  /** Token-expiry only ever applies here — once a machine row is observed, Decision 8/Final Review Clarifications forbid showing `expired` again, even if the machine later goes offline. */
  | { phase: "expired"; mint: MintEnrollmentTokenOutput }
  /** Stage 1 reached. Decision 8: the registration-timeout clock starts now, not at mint time. */
  | { phase: "waiting-agent"; mint: MintEnrollmentTokenOutput; machine: MachineVO }
  /** Final Review Clarifications: a redeemed machine (row exists) that is observed offline after the token deadline — reconnect progress, never token-expired. */
  | { phase: "offline-reconnect"; mint: MintEnrollmentTokenOutput }
  | { phase: "registration-timed-out"; mint: MintEnrollmentTokenOutput }
  | { phase: "mismatched"; mint: MintEnrollmentTokenOutput; agent: AgentVO }
  | { phase: "agent-auth-required"; mint: MintEnrollmentTokenOutput; agent: AgentVO }
  | { phase: "agent-error"; mint: MintEnrollmentTokenOutput; agent: AgentVO }
  | { phase: "starting-session"; mint: MintEnrollmentTokenOutput; agent: AgentVO }
  | { phase: "preparation-timed-out"; mint: MintEnrollmentTokenOutput; agent: AgentVO }
  | { phase: "start-error"; mint: MintEnrollmentTokenOutput; agent: AgentVO; message: string }
  | { phase: "handed-off"; agentId: string; sessionId: string };

export interface EnrollmentDeps {
  mint: (intendedAgentSlug: string) => Promise<MintEnrollmentTokenOutput>;
  listMachines: () => Promise<MachineVO[]>;
  listAgents: () => Promise<AgentVO[]>;
  startSession: (agentId: string) => Promise<{ sessionId: string }>;
  /** Fire-and-forget disposal for a session this flow started but can no longer hand off (Decision 7). Must not throw synchronously; rejections are the caller's concern. */
  endSession: (agentId: string, sessionId: string) => Promise<{ ok: boolean }>;
  now: () => number;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const TERMINAL_PHASES = new Set<EnrollmentPhase["phase"]>([
  "mint-error",
  "expired",
  "registration-timed-out",
  "mismatched",
  "agent-auth-required",
  "agent-error",
  "preparation-timed-out",
  "start-error",
  "handed-off",
]);

/**
 * True once no further automatic poll should be scheduled for the CURRENT
 * phase. `waiting-agent`/`waiting-machine`/`starting-session` keep polling;
 * `offline-reconnect` keeps polling too (recovery is automatic once the
 * machine reconnects) — every other phase is a stopping point until the user
 * explicitly retries (which starts a fresh generation, see `retry`).
 */
function isTerminal(phase: EnrollmentPhase["phase"]): boolean {
  return TERMINAL_PHASES.has(phase);
}

/**
 * Phases where the user-facing "Check again" affordance is offered at all.
 * The flow is the single source of truth for this set — `AddAgentDialog`
 * reads `state.canRetry` instead of keeping its own copy, so the "retry
 * blocked while a start is still unresolved" rule (see `EnrollmentFlowState`)
 * can never drift out of sync between the two.
 */
export const RETRYABLE_PHASES = new Set<EnrollmentPhase["phase"]>([
  "registration-timed-out",
  "preparation-timed-out",
  "agent-auth-required",
  "agent-error",
  "start-error",
  "offline-reconnect",
]);

export interface EnrollmentFlowState {
  phase: EnrollmentPhase;
  generation: number;
  /**
   * False while an older or current-generation `sessions.start` call is
   * still unresolved — the dialog must show a waiting explanation instead
   * of a clickable "Check again" in that window (Final Review
   * Clarifications: "retry during pending must remain blocked, expose
   * canRetry false with waiting explanation"). This is independent of
   * `phase`: `preparation-timed-out` is otherwise a retryable phase, but
   * stays blocked here until the stale start it's still attached to
   * actually settles.
   */
  canRetry: boolean;
  /**
   * Outcome of the most recent best-effort disposal (Decision 7) of an
   * abandoned/late/superseded `sessions.start` result, or `null` if none has
   * run yet this attempt. Tracked (not just fire-and-forgotten) so a mounted
   * dialog can show a retry affordance instead of silently losing a
   * best-effort cleanup to a transport rejection or an `ok:false` response —
   * apply-context.txt #4: "track best-effort logical cleanup failures
   * (transport reject and ok:false), show mounted retry cleanup affordance."
   * `"pending"` while the disposal call is in flight; `"ok"`/`"failed"` once
   * settled. Never implies the backend process was actually terminated.
   */
  lastCleanup: { agentId: string; sessionId: string; status: "pending" | "ok" | "failed" } | null;
}

export interface EnrollmentFlow {
  getState: () => EnrollmentFlowState;
  subscribe: (listener: (state: EnrollmentFlowState) => void) => () => void;
  /** Begins stage 1 (mint). Called once per dialog-open. */
  start: (intendedAgentSlug: string, registrySlug: string) => void;
  /**
   * Resumes polling the SAME machine identity under a bumped generation —
   * never re-mints, never starts a second concurrent pending attempt
   * (design.md Decision 8, Final Review Clarifications "retry generations").
   * Valid from `registration-timed-out`, `preparation-timed-out`,
   * `agent-error`, `start-error`, and `offline-reconnect`.
   */
  retry: () => void;
  /**
   * Marks the flow abandoned: bumps the generation so every in-flight
   * callback becomes stale (Decision 4), and disposes a started-but-
   * unresolved session once/if it resolves (Decision 7). Idempotent.
   */
  close: () => void;
  /**
   * Re-fires best-effort disposal for the most recent cleanup attempt, if
   * and only if that attempt's status is `"failed"` — the mounted retry
   * affordance apply-context.txt #4 requires. No-op if there is no tracked
   * cleanup, or it already succeeded, or one is still in flight (retrying a
   * `"pending"` disposal would just race itself).
   */
  retryCleanup: () => void;
}

/**
 * Creates one enrollment-flow coordinator instance — one per dialog "open"
 * lifetime (the dialog creates a new instance each time it opens, mirroring
 * today's `useEffect` keyed on `open`).
 */
export function createEnrollmentFlow(deps: EnrollmentDeps): EnrollmentFlow {
  let generation = 0;
  let phase: EnrollmentPhase = { phase: "minting" };
  const listeners = new Set<(state: EnrollmentFlowState) => void>();

  // Single-flight guard: at most one poll timer in flight at a time
  // (Decision 4) — the next tick is scheduled only in `.finally()`, after
  // this tick's own async work has fully settled, so a slow response can
  // never overlap with the next scheduled check.
  let pollTimer: unknown = null;
  let registrationDeadlineTimer: unknown = null;
  let preparationDeadlineTimer: unknown = null;
  // Decision 7: ownership of an in-flight `sessions.start` call. Retained so
  // a late resolution arriving after the generation that started it has been
  // superseded can still be disposed of (never silently dropped).
  let pendingStart: {
    generation: number;
    agentId: string;
    promise: Promise<{ sessionId: string }>;
  } | null = null;
  // Mirrors the already-online machine for this attempt once stage 1 is
  // reached, so a retry can resume polling the same identity without
  // re-reading it from a stale closure.
  let currentMint: MintEnrollmentTokenOutput | null = null;
  let registrySlugForAttempt: string | null = null;
  let machineObservedOnline = false;
  let lastKnownMachine: MachineVO | null = null;
  // apply-context.txt #4: tracked (not fire-and-forgotten) so a mounted
  // dialog can surface a retry affordance for a disposal that actually
  // failed, instead of the outcome vanishing into an untracked `.catch()`.
  let lastCleanup: EnrollmentFlowState["lastCleanup"] = null;

  const emit = () => {
    const snapshot: EnrollmentFlowState = {
      phase,
      generation,
      canRetry: RETRYABLE_PHASES.has(phase.phase) && pendingStart === null,
      lastCleanup,
    };
    for (const listener of listeners) listener(snapshot);
  };

  const setPhase = (next: EnrollmentPhase) => {
    phase = next;
    emit();
  };

  const clearPollTimer = () => {
    if (pollTimer !== null) {
      deps.clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const clearRegistrationDeadline = () => {
    if (registrationDeadlineTimer !== null) {
      deps.clearTimeout(registrationDeadlineTimer);
      registrationDeadlineTimer = null;
    }
  };

  const clearPreparationDeadline = () => {
    if (preparationDeadlineTimer !== null) {
      deps.clearTimeout(preparationDeadlineTimer);
      preparationDeadlineTimer = null;
    }
  };

  /**
   * Arms (or re-arms) the stage-2 registration deadline for generation `gen`,
   * starting from "now" — Decision 8: measured from the moment the machine
   * is observed online, never from mint time. Used both the first time stage
   * 1 is reached inside `pollTick` AND by `retry()` when resuming into
   * `waiting-agent`/`offline-reconnect` from `registration-timed-out`: a
   * "check again" that resumes the SAME machine identity must still be
   * bounded by its own fresh wait, not left polling forever just because
   * `machineObservedOnline` is already `true` and `pollTick`'s own
   * first-observation branch (the only other place this timer was armed)
   * can therefore never run again for this attempt.
   */
  const armRegistrationDeadline = (gen: number) => {
    clearRegistrationDeadline();
    registrationDeadlineTimer = deps.setTimeout(() => {
      registrationDeadlineTimer = null;
      if (gen !== generation) return;
      if (phase.phase === "waiting-agent" || phase.phase === "offline-reconnect") {
        setPhase({
          phase: "registration-timed-out",
          mint: currentMint as MintEnrollmentTokenOutput,
        });
      }
    }, AGENT_REGISTRATION_TIMEOUT_MS);
  };

  /**
   * Fire-and-forget disposal (Decision 7) — never awaited by anything
   * blocking the UI, but its outcome IS tracked (`lastCleanup`) rather than
   * swallowed: a transport rejection and an `ok:false` response are both
   * "cleanup failed" (apply-context.txt #4), each surfaced to the mounted
   * dialog via `emit()` so a retry affordance can appear instead of the
   * session leaking silently. Never claims the backend process was killed —
   * `"ok"` only means `endSession`'s own promise resolved truthy.
   */
  const disposeSession = (agentId: string, sessionId: string) => {
    lastCleanup = { agentId, sessionId, status: "pending" };
    emit();
    void deps.endSession(agentId, sessionId).then(
      (result) => {
        // A newer disposal (a different agentId/sessionId pair) may already
        // be in flight by the time this settles — never let a stale result
        // overwrite a more recent attempt's tracked status.
        if (lastCleanup?.agentId !== agentId || lastCleanup.sessionId !== sessionId) return;
        lastCleanup = { agentId, sessionId, status: result.ok ? "ok" : "failed" };
        emit();
      },
      () => {
        if (lastCleanup?.agentId !== agentId || lastCleanup.sessionId !== sessionId) return;
        lastCleanup = { agentId, sessionId, status: "failed" };
        emit();
      },
    );
  };

  /**
   * Stage 3: calls `sessions.start` exactly once per generation, renders
   * `starting-session` immediately, and resolves to either the parent
   * handoff (`handed-off`) or disposal (Decision 7) depending on whether this
   * generation is still current when the call settles.
   *
   * Guards on ANY unresolved `pendingStart`, not merely one matching this
   * generation (Final Review Clarifications: "disable another start while
   * the previous start is unresolved"). A `retry()` from
   * `preparation-timed-out` bumps the generation but — correctly — does NOT
   * clear a still-outstanding `pendingStart`, so this check still blocks a
   * second concurrent `sessions.start` for the same abandoned-but-not-yet-
   * settled call. Once that old call finally settles (handled below), the
   * guard opens back up and the current generation's own poll tick is free
   * to call this again on its next run.
   */
  const beginSessionStart = (gen: number, mint: MintEnrollmentTokenOutput, agent: AgentVO) => {
    if (pendingStart) return; // an older or current-generation start is still unresolved
    setPhase({ phase: "starting-session", mint, agent });

    clearPreparationDeadline();
    // `starting-session`'s own deadline must not race the registration-stage
    // deadline still running from stage 2.
    clearRegistrationDeadline();
    preparationDeadlineTimer = deps.setTimeout(() => {
      preparationDeadlineTimer = null;
      if (gen !== generation) return;
      if (phase.phase !== "starting-session") return;
      setPhase({ phase: "preparation-timed-out", mint, agent });
      // Timeout is NOT readiness and does not cancel the backend call —
      // `pendingStart` is left as-is so a late resolution is still disposed
      // of correctly below, per Decision 8 / Final Review Clarifications.
    }, SESSION_PREPARATION_TIMEOUT_MS);

    const promise = deps.startSession(agent.id);
    pendingStart = { generation: gen, agentId: agent.id, promise };

    promise.then(
      (result) => {
        if (pendingStart?.promise === promise) pendingStart = null;
        if (gen !== generation) {
          // Superseded (dialog closed / new attempt / retry) before this
          // resolved — never hand off a result nobody is looking at anymore.
          disposeSession(agent.id, result.sessionId);
          return;
        }
        if (phase.phase === "preparation-timed-out" || isTerminal(phase.phase)) {
          // Late result after this generation's own terminal transition
          // (e.g. the 180s deadline already fired) — Decision 7/8: dispose,
          // never navigate to it.
          disposeSession(agent.id, result.sessionId);
          return;
        }
        clearPreparationDeadline();
        setPhase({ phase: "handed-off", agentId: agent.id, sessionId: result.sessionId });
      },
      (error: unknown) => {
        if (pendingStart?.promise === promise) pendingStart = null;
        if (gen !== generation) return; // nothing to show; attempt already abandoned
        clearPreparationDeadline();
        setPhase({
          phase: "start-error",
          mint,
          agent,
          message: error instanceof Error ? error.message : "Could not start a session.",
        });
      },
    );
  };

  // `starting-session`'s own deadline must not be clobbered by the
  // registration-stage deadline timer still running from stage 2 — this
  // clears it defensively before arming the stage-3 one.

  /** One poll tick: lists machines/agents, advances phase, then — only once this tick's own async work has fully settled — schedules the next tick (Decision 4: never two in flight at once). */
  const scheduleNextPoll = (gen: number, run: () => Promise<void>) => {
    clearPollTimer();
    pollTimer = deps.setTimeout(() => {
      pollTimer = null;
      if (gen !== generation) return;
      if (isTerminal(phase.phase)) return;
      run()
        .catch(() => undefined)
        .finally(() => {
          if (gen === generation && !isTerminal(phase.phase)) {
            scheduleNextPoll(gen, run);
          }
        });
    }, POLL_INTERVAL_MS);
  };

  const pollTick = async (gen: number) => {
    if (gen !== generation || !currentMint || !registrySlugForAttempt) return;
    const mint = currentMint;
    const registrySlug = registrySlugForAttempt;

    if (!machineObservedOnline) {
      // Stage 0->1: still waiting for the machine itself. Token expiry can
      // only end this stage if NO row for this attempt's machineId has ever
      // been observed yet — the machine list must be fetched and checked
      // FIRST, every tick, so a row that already exists by the time expiry
      // would otherwise fire is still correctly treated as progress, not
      // failure (Final Review Clarifications: "query current machine rows
      // before applying the token deadline; once any row for this minted ID
      // is observed, never show token expired, even if the machine is
      // offline" — this must hold on the very first observation too, not
      // only once `machineObservedOnline` was already true from an earlier
      // tick).
      const machines = await deps.listMachines();
      if (gen !== generation || isTerminal(phase.phase)) return;
      const machine = machines.find((m) => m.id === mint.machineId);
      if (!machine && deps.now() > new Date(mint.expiresAt).getTime()) {
        setPhase({ phase: "expired", mint });
        return;
      }
      if (machine && machine.status === "online") {
        machineObservedOnline = true;
        lastKnownMachine = machine;
        setPhase({ phase: "waiting-agent", mint, machine });
        armRegistrationDeadline(gen);
      } else if (machine && machine.status !== "online") {
        // Final Review Clarifications: a row exists but is offline — this is
        // enrollment progress, not proof of a live bridge. Never treat as
        // token-expired from here on, even though the machine isn't online.
        machineObservedOnline = true;
        lastKnownMachine = machine;
        setPhase({ phase: "offline-reconnect", mint });
        armRegistrationDeadline(gen);
      }
      return;
    }

    // Stage 1 reached (machine row observed, online or not): poll for the
    // matching, authenticated agent. Never re-check token expiry past this
    // point (Context fact 5 / Final Review Clarifications).
    const results = await Promise.allSettled([deps.listMachines(), deps.listAgents()]);
    if (gen !== generation || isTerminal(phase.phase)) return;
    if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled") return;
    const machines = results[0].value;
    const agents = results[1].value;

    const machine = machines.find((m) => m.id === mint.machineId) ?? null;
    const online = machine?.status === "online";
    if (machine) lastKnownMachine = machine;

    if (!online) {
      if (phase.phase === "waiting-agent") {
        setPhase({ phase: "offline-reconnect", mint });
      }
      return;
    }

    const match = findMatchingAgent(agents, mint.machineId, registrySlug);
    if (match.kind === "mismatched") {
      clearRegistrationDeadline();
      setPhase({ phase: "mismatched", mint, agent: match.agent });
      return;
    }
    if (match.kind === "not-found") {
      if (phase.phase === "offline-reconnect") {
        setPhase({ phase: "waiting-agent", mint, machine: machine as MachineVO });
      }
      return;
    }

    const agent = match.agent;
    if (agent.status === "auth_required") {
      clearRegistrationDeadline();
      setPhase({ phase: "agent-auth-required", mint, agent });
      return;
    }
    if (agent.status === "error") {
      clearRegistrationDeadline();
      setPhase({ phase: "agent-error", mint, agent });
      return;
    }
    if (agent.status === "connected") {
      clearRegistrationDeadline();
      beginSessionStart(gen, mint, agent);
    }
  };

  const bumpGenerationAndStopPolling = () => {
    clearPollTimer();
    clearRegistrationDeadline();
    clearPreparationDeadline();
    generation += 1;
  };

  const start = (intendedAgentSlug: string, registrySlug: string) => {
    bumpGenerationAndStopPolling();
    const gen = generation;
    machineObservedOnline = false;
    lastKnownMachine = null;
    currentMint = null;
    registrySlugForAttempt = registrySlug;
    pendingStart = null;
    lastCleanup = null; // a brand-new attempt starts with no cleanup history of its own
    setPhase({ phase: "minting" });

    deps.mint(intendedAgentSlug).then(
      (mint) => {
        if (gen !== generation) return;
        currentMint = mint;
        setPhase({ phase: "waiting-machine", mint });
        scheduleNextPoll(gen, () => pollTick(gen));
      },
      (error: unknown) => {
        if (gen !== generation) return;
        setPhase({
          phase: "mint-error",
          message: error instanceof Error ? error.message : "Could not create an enrollment token.",
        });
      },
    );
  };

  const retry = () => {
    if (!currentMint || !registrySlugForAttempt) return;
    // Final Review Clarifications: "disable another start while the
    // previous start is unresolved" — a `preparation-timed-out` retry must
    // NOT clear `pendingStart`. The old call is still genuinely in flight
    // against the real backend; clearing the reference here would only hide
    // it from the new generation's own guard, letting `beginSessionStart`
    // issue a second concurrent `sessions.start` for the same agent. Leaving
    // it set means `canRetry` (computed below) reports `false` and the
    // dialog shows a waiting explanation instead of a clickable retry.
    if (pendingStart) return;
    const mint = currentMint;
    // Resumed generation, same machine identity — never re-mint (Decision 8 /
    // Final Review Clarifications "retry generations"). `offline-reconnect`,
    // `registration-timed-out`, `agent-error`, `start-error`, and
    // `preparation-timed-out` (once its own pendingStart has settled) all
    // resume from here.
    clearPollTimer();
    clearRegistrationDeadline();
    clearPreparationDeadline();
    generation += 1;
    const gen = generation;
    const resumingIntoAgentWait = machineObservedOnline && lastKnownMachine;
    setPhase(
      resumingIntoAgentWait
        ? { phase: "waiting-agent", mint, machine: lastKnownMachine as MachineVO }
        : { phase: "waiting-machine", mint },
    );
    // Bug fix (apply-context.txt #7): `pollTick`'s stage-1-detection branch —
    // the ONLY other place `armRegistrationDeadline` is called — never runs
    // again once `machineObservedOnline` is already `true`, which it is for
    // every retry that resumes into `waiting-agent`/`offline-reconnect`
    // (including the `registration-timed-out` -> "Check again" path this
    // bug was found on). Without re-arming here, a retry that resumes
    // waiting for the agent would poll forever with no second timeout if the
    // agent still never registers.
    if (resumingIntoAgentWait) armRegistrationDeadline(gen);
    scheduleNextPoll(gen, () => pollTick(gen));
  };

  const close = () => {
    bumpGenerationAndStopPolling();
    // Decision 7: nothing more to do for a call never made; a call already
    // in flight is left to resolve and dispose itself via `pendingStart`'s
    // own `then` handler above, which independently checks staleness.
  };

  const retryCleanup = () => {
    if (!lastCleanup || lastCleanup.status !== "failed") return;
    disposeSession(lastCleanup.agentId, lastCleanup.sessionId);
  };

  return {
    getState: () => ({
      phase,
      generation,
      canRetry: RETRYABLE_PHASES.has(phase.phase) && pendingStart === null,
      lastCleanup,
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    retry,
    close,
    retryCleanup,
  };
}
