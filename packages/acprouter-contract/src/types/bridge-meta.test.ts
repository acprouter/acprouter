import { describe, expect, it } from "vitest";
import { parseBridgeInitializeMeta } from "./bridge-meta";

describe("parseBridgeInitializeMeta", () => {
  it("parses a real, fully-populated payload", () => {
    const meta = {
      registrySlug: "claude-acp",
      cwd: "/home/kelly/projects/foo",
      detectedVersion: "2.1.228 (Claude Code)",
      authState: "ok",
      authDetail: null,
    };
    expect(parseBridgeInitializeMeta(meta)).toEqual(meta);
  });

  it("parses a payload with every field null (an enrolled-but-unconfigured machine)", () => {
    const meta = {
      registrySlug: null,
      cwd: null,
      detectedVersion: null,
      authState: null,
      authDetail: null,
    };
    expect(parseBridgeInitializeMeta(meta)).toEqual(meta);
  });

  it("returns null, not a thrown error, for undefined _meta (an old CLI build that predates this field)", () => {
    expect(parseBridgeInitializeMeta(undefined)).toBeNull();
  });

  it("returns null for null _meta", () => {
    expect(parseBridgeInitializeMeta(null)).toBeNull();
  });

  it("returns null for a non-object _meta (a misbehaving CLI sending a string/number)", () => {
    expect(parseBridgeInitializeMeta("not an object")).toBeNull();
    expect(parseBridgeInitializeMeta(42)).toBeNull();
  });

  it("returns null for an object missing required fields, rather than partially trusting it", () => {
    expect(parseBridgeInitializeMeta({ registrySlug: "claude-acp" })).toBeNull();
  });

  it("returns null for an authState outside the known enum (protocol drift between CLI and Router versions)", () => {
    expect(
      parseBridgeInitializeMeta({
        registrySlug: null,
        cwd: null,
        detectedVersion: null,
        authState: "some_future_state",
        authDetail: null,
      }),
    ).toBeNull();
  });

  it("returns null for the wrong type on a field (e.g. cwd sent as a number)", () => {
    expect(
      parseBridgeInitializeMeta({
        registrySlug: null,
        cwd: 12345,
        detectedVersion: null,
        authState: null,
        authDetail: null,
      }),
    ).toBeNull();
  });
});
