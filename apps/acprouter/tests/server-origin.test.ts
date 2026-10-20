import { describe, expect, it } from "vitest";
import { resolveServerOrigin } from "~/lib/server-origin";

describe("resolveServerOrigin", () => {
  const internalRequestUrl = "https://0.0.0.0:3000/api/rpc/agents/machines/mint";

  it("uses ACPROUTER_PUBLIC_URL instead of the container listener", () => {
    expect(
      resolveServerOrigin(internalRequestUrl, {
        ACPROUTER_PUBLIC_URL: "https://acprouter-demo.bika.ltd/",
      }),
    ).toBe("https://acprouter-demo.bika.ltd");
  });

  it("supports NEXT_PUBLIC_APP_URL for compatibility with existing deployments", () => {
    expect(
      resolveServerOrigin(internalRequestUrl, {
        NEXT_PUBLIC_APP_URL: "https://acprouter-demo.bika.ltd",
      }),
    ).toBe("https://acprouter-demo.bika.ltd");
  });

  it("reads the public URL from process.env at runtime", () => {
    const originalPublicUrl = process.env.ACPROUTER_PUBLIC_URL;
    const originalCompatibleUrl = process.env.NEXT_PUBLIC_APP_URL;
    try {
      process.env.ACPROUTER_PUBLIC_URL = "https://runtime.example.com";
      delete process.env.NEXT_PUBLIC_APP_URL;
      expect(resolveServerOrigin(internalRequestUrl)).toBe("https://runtime.example.com");
    } finally {
      if (originalPublicUrl === undefined) delete process.env.ACPROUTER_PUBLIC_URL;
      else process.env.ACPROUTER_PUBLIC_URL = originalPublicUrl;
      if (originalCompatibleUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = originalCompatibleUrl;
    }
  });

  it("prefers the server-only variable when both variables are set", () => {
    expect(
      resolveServerOrigin(internalRequestUrl, {
        ACPROUTER_PUBLIC_URL: "https://router.example.com",
        NEXT_PUBLIC_APP_URL: "https://legacy.example.com",
      }),
    ).toBe("https://router.example.com");
  });

  it("falls back to the request origin for local development", () => {
    expect(resolveServerOrigin("http://127.0.0.1:15420/api/rpc", {})).toBe(
      "http://127.0.0.1:15420",
    );
  });

  it.each([
    "acprouter-demo.bika.ltd",
    "ftp://acprouter-demo.bika.ltd",
    "https://acprouter-demo.bika.ltd/router",
    "https://user:password@acprouter-demo.bika.ltd",
  ])("rejects an invalid public URL: %s", (value) => {
    expect(() => resolveServerOrigin(internalRequestUrl, { ACPROUTER_PUBLIC_URL: value })).toThrow(
      "ACPROUTER_PUBLIC_URL",
    );
  });
});
