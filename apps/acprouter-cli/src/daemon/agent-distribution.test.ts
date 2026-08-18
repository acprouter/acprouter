import { describe, expect, it } from "vitest";
import { resolveAgentDistribution } from "./agent-distribution";

describe("resolveAgentDistribution", () => {
  it("resolves claude-acp to its pinned npx package", () => {
    expect(resolveAgentDistribution("claude-acp")).toEqual({
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.67.0"],
    });
  });

  it("resolves codex-acp to its pinned npx package", () => {
    expect(resolveAgentDistribution("codex-acp")).toEqual({
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp@1.2.0"],
    });
  });

  it("fails closed (returns null) for a slug not in the pinned registry", () => {
    expect(resolveAgentDistribution("totally-made-up-slug")).toBeNull();
  });
});
