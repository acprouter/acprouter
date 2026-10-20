import type { AcpUiEvent } from "@acp-ui/core/reduce";
import type { AgentSessionStreamEventVO } from "@acprouter/contract";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionPort } from "./agent-session-port";

/** Minimal shape of the slice of `AcprouterAgentsClient` this port touches. */
function createOrpc(overrides: Record<string, unknown> = {}) {
  return {
    agents: {
      sessions: {
        start: vi.fn(async () => ({ sessionId: "started-session" })),
        history: vi.fn(async () => [] as AgentSessionStreamEventVO[]),
        prompt: vi.fn(async () => (async function* () {})()),
        answerPermission: vi.fn(async () => ({ answered: true })),
        end: vi.fn(async () => ({ ok: true })),
        cancelTurn: vi.fn(async () => undefined),
        ...((overrides.sessions as Record<string, unknown>) ?? {}),
      },
    },
  } as unknown as Parameters<typeof createAgentSessionPort>[0]["orpc"];
}

function createDeps(overrides: Partial<Parameters<typeof createAgentSessionPort>[0]> = {}) {
  return {
    orpc: createOrpc(),
    agentId: "agent-1",
    adoptedSessionId: null,
    rememberSession: vi.fn(),
    getPreviousSessionId: () => null,
    outstandingPermissionRef: { current: null },
    sinkRef: { current: null },
    activeIteratorRef: { current: null },
    ...overrides,
  };
}

describe("createAgentSessionPort", () => {
  describe("start", () => {
    it("calls orpc.agents.sessions.start and remembers the result when no adoptedSessionId is given (task 7.2 — no regression on manual-Open)", async () => {
      const orpc = createOrpc();
      const rememberSession = vi.fn();
      const port = createAgentSessionPort(
        createDeps({ orpc, agentId: "agent-1", adoptedSessionId: null, rememberSession }),
      );

      const sessionId = await port.start(new AbortController().signal);

      expect(sessionId).toBe("started-session");
      expect(orpc.agents.sessions.start).toHaveBeenCalledWith({ agentId: "agent-1" });
      expect(rememberSession).toHaveBeenCalledWith("agent-1", "started-session");
    });

    it("resolves to adoptedSessionId directly without calling orpc.agents.sessions.start (task 7.1)", async () => {
      const orpc = createOrpc();
      const rememberSession = vi.fn();
      const port = createAgentSessionPort(
        createDeps({
          orpc,
          agentId: "agent-1",
          adoptedSessionId: "adopted-session",
          rememberSession,
        }),
      );

      const sessionId = await port.start(new AbortController().signal);

      expect(sessionId).toBe("adopted-session");
      expect(orpc.agents.sessions.start).not.toHaveBeenCalled();
      expect(rememberSession).toHaveBeenCalledWith("agent-1", "adopted-session");
    });

    it("omitting adoptedSessionId entirely behaves exactly like passing null (task 7.2)", async () => {
      const orpc = createOrpc();
      const port = createAgentSessionPort(createDeps({ orpc, adoptedSessionId: undefined }));

      await port.start(new AbortController().signal);

      expect(orpc.agents.sessions.start).toHaveBeenCalledTimes(1);
    });

    it("fires onAdopted with (agentId, sessionId) the instant start() resolves via adoption", async () => {
      const onAdopted = vi.fn();
      const port = createAgentSessionPort(
        createDeps({ agentId: "agent-1", adoptedSessionId: "adopted-session", onAdopted }),
      );

      await port.start(new AbortController().signal);

      expect(onAdopted).toHaveBeenCalledWith("agent-1", "adopted-session");
      expect(onAdopted).toHaveBeenCalledTimes(1);
    });

    it("never fires onAdopted on the non-adoption (manual-Open) path", async () => {
      const onAdopted = vi.fn();
      const port = createAgentSessionPort(
        createDeps({ agentId: "agent-1", adoptedSessionId: null, onAdopted }),
      );

      await port.start(new AbortController().signal);

      expect(onAdopted).not.toHaveBeenCalled();
    });

    it("omitting onAdopted entirely does not throw on the adoption path", async () => {
      const port = createAgentSessionPort(
        createDeps({
          agentId: "agent-1",
          adoptedSessionId: "adopted-session",
          onAdopted: undefined,
        }),
      );

      await expect(port.start(new AbortController().signal)).resolves.toBe("adopted-session");
    });
  });

  describe("history", () => {
    it("folds in the previous session's history as scrollback ahead of the current session's own history", async () => {
      const previousEvents: AgentSessionStreamEventVO[] = [
        { type: "note", text: "previous note" } as AgentSessionStreamEventVO,
      ];
      const ownEvents: AgentSessionStreamEventVO[] = [
        { type: "note", text: "own note" } as AgentSessionStreamEventVO,
      ];
      const orpc = createOrpc({
        sessions: {
          history: vi.fn(async ({ sessionId }: { sessionId: string }) =>
            sessionId === "previous-session" ? previousEvents : ownEvents,
          ),
        },
      });
      const port = createAgentSessionPort(
        createDeps({ orpc, getPreviousSessionId: () => "previous-session" }),
      );

      const events = await port.history?.("current-session", new AbortController().signal);

      expect(events).toEqual<AcpUiEvent[]>([
        { type: "note", text: "previous note" },
        { type: "note", text: "own note" },
      ]);
    });

    it("fetches no previous history when getPreviousSessionId matches the current sessionId", async () => {
      const orpc = createOrpc();
      const port = createAgentSessionPort(
        createDeps({ orpc, getPreviousSessionId: () => "current-session" }),
      );

      await port.history?.("current-session", new AbortController().signal);

      expect(orpc.agents.sessions.history).toHaveBeenCalledTimes(1);
      expect(orpc.agents.sessions.history).toHaveBeenCalledWith({ sessionId: "current-session" });
    });
  });

  describe("end", () => {
    it("fires orpc.agents.sessions.end and swallows a rejection (fire-and-forget)", async () => {
      const orpc = createOrpc({
        sessions: { end: vi.fn(async () => Promise.reject(new Error("boom"))) },
      });
      const port = createAgentSessionPort(createDeps({ orpc, agentId: "agent-1" }));

      expect(() => port.end?.("session-1")).not.toThrow();
      expect(orpc.agents.sessions.end).toHaveBeenCalledWith({
        agentId: "agent-1",
        sessionId: "session-1",
      });
    });
  });

  it("serverEchoesPrompt is false (acprouter emits nothing for the user's own prompt)", () => {
    const port = createAgentSessionPort(createDeps());
    expect(port.serverEchoesPrompt).toBe(false);
  });
});
