import { describe, expect, it } from "vitest";
import { toBridgeWebSocketHeaders, toBridgeWebSocketUrl } from "./bridge-url";

describe("toBridgeWebSocketUrl", () => {
  it("rewrites https to wss and carries machineId as a query param, never a credential", () => {
    const url = toBridgeWebSocketUrl("https://router.example.test", "machine_123");
    expect(url).toBe("wss://router.example.test/api/machines/bridge?machineId=machine_123");
  });

  it("rewrites http to ws for a plain self-hosted Router", () => {
    const url = toBridgeWebSocketUrl("http://localhost:3000", "machine_abc");
    expect(url).toBe("ws://localhost:3000/api/machines/bridge?machineId=machine_abc");
  });
});

describe("toBridgeWebSocketHeaders — task #6.4", () => {
  it("returns an Authorization bearer header when a bridge credential is present", () => {
    expect(toBridgeWebSocketHeaders("raw-secret")).toEqual({
      Authorization: "Bearer raw-secret",
    });
  });

  it("returns undefined (no header at all) when there is no bridge credential", () => {
    expect(toBridgeWebSocketHeaders(undefined)).toBeUndefined();
  });

  it("never embeds the credential value in the connection URL itself", () => {
    const url = toBridgeWebSocketUrl("https://router.example.test", "machine_123");
    const headers = toBridgeWebSocketHeaders("super-secret-value");
    expect(url).not.toContain("super-secret-value");
    expect(headers?.Authorization).toContain("super-secret-value");
  });
});
