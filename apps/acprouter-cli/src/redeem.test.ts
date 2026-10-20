import { afterEach, expect, it, vi } from "vitest";
import { redeemEnrollmentToken } from "./redeem";

afterEach(() => vi.unstubAllGlobals());

it("does not follow credential-bearing enrollment redirects", async () => {
  const fetchSpy = vi.fn(
    async (_url: string | URL, _init?: RequestInit) =>
      new Response(null, { status: 307, headers: { location: "https://different-origin.test" } }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  await expect(
    redeemEnrollmentToken("https://router.test", "test-placeholder", "Test", "test"),
  ).rejects.toMatchObject({ code: "unexpected_redirect" });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
});
