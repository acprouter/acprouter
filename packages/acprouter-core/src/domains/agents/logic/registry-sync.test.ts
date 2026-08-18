import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProtocolMatrix, fetchRegistry, getAgentCatalog } from "./registry-sync";

describe("registry-sync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the pinned snapshot when the live registry is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    const { agents, source } = await fetchRegistry();
    expect(source).toBe("pinned");
    // The pinned snapshot must actually contain what the MVP resolves against —
    // an empty or wrong fallback would silently degrade the catalog to defaults.
    expect(agents.some((a) => a.id === "claude-acp")).toBe(true);
    expect(agents.some((a) => a.id === "codex-acp")).toBe(true);
  });

  it("falls back to the pinned snapshot when the live registry returns a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("nope", { status: 500 }))),
    );
    const { source } = await fetchRegistry();
    expect(source).toBe("pinned");
  });

  it("falls back to the pinned protocol matrix when the live fetch fails, and still resolves known agents", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    const { byId, source } = await fetchProtocolMatrix();
    expect(source).toBe("pinned");
    expect(byId.has("claude-acp")).toBe(true);
    expect(byId.has("codex-acp")).toBe(true);
  });

  it("getAgentCatalog resolves the two bridged MVP entries plus the static Buda entry, never empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    const catalog = await getAgentCatalog();
    expect(catalog).toHaveLength(3);

    const claude = catalog.find((e) => e.id === "claude-acp");
    expect(claude).toMatchObject({ kind: "bridged", source: "pinned" });
    expect(claude?.version).toMatch(/^\d+\.\d+\.\d+$/);

    const codex = catalog.find((e) => e.id === "codex-acp");
    expect(codex).toMatchObject({ kind: "bridged", source: "pinned" });
    expect(codex?.version).toMatch(/^\d+\.\d+\.\d+$/);

    const buda = catalog.find((e) => e.id === "buda");
    expect(buda).toMatchObject({ kind: "remote-acp", source: "static", version: null });
  });

  it("getAgentCatalog reports source: live when the registry fetch actually succeeds", async () => {
    const fakeRegistry = {
      version: "1.0.0",
      agents: [
        {
          id: "claude-acp",
          name: "Claude Agent",
          version: "9.9.9",
          description: "test override",
          distribution: { npx: { package: "@agentclientprotocol/claude-agent-acp@9.9.9" } },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(fakeRegistry), { status: 200 }))),
    );
    const catalog = await getAgentCatalog();
    const claude = catalog.find((e) => e.id === "claude-acp");
    expect(claude).toMatchObject({ version: "9.9.9", source: "live" });
  });
});
