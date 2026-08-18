import { describe, expect, it } from "vitest";
import { isLoopbackHost, shouldShowExposureBanner } from "~/lib/exposure-banner";

describe("isLoopbackHost", () => {
  it("treats localhost, 127.0.0.1, and ::1 as loopback, with or without a port", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("localhost:15420")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:15420")).toBe(true);
    expect(isLoopbackHost("[::1]:15420")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("treats a real hostname or LAN/public IP as non-loopback", () => {
    expect(isLoopbackHost("router.example.com")).toBe(false);
    expect(isLoopbackHost("192.168.1.20:15420")).toBe(false);
    expect(isLoopbackHost("203.0.113.5")).toBe(false);
  });

  it("defaults a missing Host to loopback rather than warning on an unanticipated caller shape", () => {
    expect(isLoopbackHost(null)).toBe(true);
    expect(isLoopbackHost(undefined)).toBe(true);
    expect(isLoopbackHost("")).toBe(true);
  });
});

describe("shouldShowExposureBanner", () => {
  it("never fires for the ordinary local-dev case — pnpm dev on 127.0.0.1:15420", () => {
    expect(
      shouldShowExposureBanner({
        hostHeader: "127.0.0.1:15420",
        forwardedHostHeader: null,
        trustReverseProxyEnv: undefined,
      }),
    ).toBe(false);
  });

  it("never fires for localhost:15420 either", () => {
    expect(
      shouldShowExposureBanner({
        hostHeader: "localhost:15420",
        forwardedHostHeader: null,
        trustReverseProxyEnv: undefined,
      }),
    ).toBe(false);
  });

  it("fires when the Host the browser dialed is not loopback", () => {
    expect(
      shouldShowExposureBanner({
        hostHeader: "203.0.113.5:15420",
        forwardedHostHeader: null,
        trustReverseProxyEnv: undefined,
      }),
    ).toBe(true);
  });

  it("prefers X-Forwarded-Host over Host when both are present", () => {
    expect(
      shouldShowExposureBanner({
        hostHeader: "127.0.0.1:15420",
        forwardedHostHeader: "router.example.com",
        trustReverseProxyEnv: undefined,
      }),
    ).toBe(true);

    expect(
      shouldShowExposureBanner({
        hostHeader: "203.0.113.5:15420",
        forwardedHostHeader: "localhost",
        trustReverseProxyEnv: undefined,
      }),
    ).toBe(false);
  });

  it("the escape hatch suppresses the banner even when the host looks exposed", () => {
    expect(
      shouldShowExposureBanner({
        hostHeader: "203.0.113.5:15420",
        forwardedHostHeader: null,
        trustReverseProxyEnv: "true",
      }),
    ).toBe(false);
  });

  it('only the exact string "true" enables the escape hatch — not "1" or truthy-looking junk', () => {
    expect(
      shouldShowExposureBanner({
        hostHeader: "203.0.113.5:15420",
        forwardedHostHeader: null,
        trustReverseProxyEnv: "1",
      }),
    ).toBe(true);
    expect(
      shouldShowExposureBanner({
        hostHeader: "203.0.113.5:15420",
        forwardedHostHeader: null,
        trustReverseProxyEnv: "yes",
      }),
    ).toBe(true);
  });
});
