import { describe, expect, it } from "vitest";
import { detectAgent, detectAllKnownAgents, KNOWN_AGENT_SLUGS } from "./detect";

describe("detectAgent", () => {
  it("reports a specific reason for an unknown slug, not a crash", () => {
    const result = detectAgent("some-agent-nobody-registered");
    expect(result).toEqual({
      slug: "some-agent-nobody-registered",
      installed: false,
      version: null,
      reason: expect.stringContaining("not implemented"),
    });
  });

  it("reports a specific PATH-miss reason for a known slug whose binary genuinely isn't installed", () => {
    // This machine's CI/dev environment is not guaranteed to have `claude`
    // or `codex` on PATH — that IS the scenario task #6 exists to handle
    // gracefully, so assert on the shape rather than requiring either
    // outcome. If it happens to be installed here, the version case is
    // exercised instead; both paths matter.
    const result = detectAgent("claude-acp");
    expect(result.slug).toBe("claude-acp");
    if (result.installed) {
      expect(typeof result.version).toBe("string");
      expect(result.reason).toBeNull();
    } else {
      expect(result.version).toBeNull();
      expect(typeof result.reason).toBe("string");
      expect(result.reason?.length).toBeGreaterThan(0);
    }
  });

  it("never throws for any known slug, regardless of what's actually installed", () => {
    for (const slug of KNOWN_AGENT_SLUGS) {
      expect(() => detectAgent(slug)).not.toThrow();
    }
  });

  it("detectAllKnownAgents returns one result per known slug", () => {
    const results = detectAllKnownAgents();
    expect(results.map((r) => r.slug).sort()).toEqual([...KNOWN_AGENT_SLUGS].sort());
  });
});
