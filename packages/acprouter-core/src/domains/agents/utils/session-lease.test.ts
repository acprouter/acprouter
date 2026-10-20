import { describe, expect, it, vi } from "vitest";
import { createSessionLease } from "./session-lease";

describe("createSessionLease", () => {
  it("starts prepared and transitions prepared -> accepted -> adopted with no disposal", () => {
    const endSession = vi.fn();
    const lease = createSessionLease("agent-1", "session-1", { endSession });

    expect(lease.getState()).toBe("prepared");
    lease.accept();
    expect(lease.getState()).toBe("accepted");
    lease.adopt();
    expect(lease.getState()).toBe("adopted");

    // Disposal after adoption must never fire — @acp-ui/core's own unmount
    // cleanup (port.end?.(sessionId)) is the disposal path from here on.
    const disposed = lease.dispose();
    expect(disposed).toBe(false);
    expect(endSession).not.toHaveBeenCalled();
  });

  it("adopt() is a no-op while still prepared (sheet cannot adopt before the parent accepts)", () => {
    const endSession = vi.fn();
    const lease = createSessionLease("agent-1", "session-1", { endSession });

    lease.adopt();
    expect(lease.getState()).toBe("prepared");
  });

  it("dispose() from prepared fires endSession exactly once and is terminal", () => {
    const endSession = vi.fn();
    const lease = createSessionLease("agent-1", "session-1", { endSession });

    const first = lease.dispose();
    expect(first).toBe(true);
    expect(endSession).toHaveBeenCalledWith("agent-1", "session-1");
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(lease.getState()).toBe("disposed");

    const second = lease.dispose();
    expect(second).toBe(false);
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it("dispose() from accepted (unmount after parent commit but before sheet adoption) fires endSession exactly once", () => {
    const endSession = vi.fn();
    const lease = createSessionLease("agent-1", "session-1", { endSession });

    lease.accept();
    const disposed = lease.dispose();
    expect(disposed).toBe(true);
    expect(endSession).toHaveBeenCalledWith("agent-1", "session-1");
    expect(lease.getState()).toBe("disposed");

    // A later, racing adopt() must not resurrect a disposed lease.
    lease.adopt();
    expect(lease.getState()).toBe("disposed");
  });

  it("accept() is idempotent and does not reset an already-adopted lease", () => {
    const endSession = vi.fn();
    const lease = createSessionLease("agent-1", "session-1", { endSession });

    lease.accept();
    lease.adopt();
    lease.accept(); // must not step backwards
    expect(lease.getState()).toBe("adopted");
  });

  it("two independent dispose() callers (e.g. direct unmount AND a deferred microtask cleanup) only end the session once", () => {
    const endSession = vi.fn();
    const lease = createSessionLease("agent-1", "session-1", { endSession });
    lease.accept();

    const results = [lease.dispose(), lease.dispose(), lease.dispose()];
    expect(results).toEqual([true, false, false]);
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it("adopt() after dispose() never flips state back to adopted", () => {
    const endSession = vi.fn();
    const lease = createSessionLease("agent-1", "session-1", { endSession });
    lease.dispose(); // disposed straight from prepared
    lease.accept();
    lease.adopt();
    expect(lease.getState()).toBe("disposed");
  });

  it("exposes the agentId/sessionId it was created with", () => {
    const lease = createSessionLease("agent-42", "session-42", { endSession: vi.fn() });
    expect(lease.agentId).toBe("agent-42");
    expect(lease.sessionId).toBe("session-42");
  });
});
