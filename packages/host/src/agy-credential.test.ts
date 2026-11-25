import { describe, expect, it, vi } from "vitest";
import { agyEnvironmentKey, agyKey, verifyAgyKey } from "./agy-credential.js";

const key = "AQ.fixture-authorization-key";

describe("AGY-15 developer credential", () => {
  it("requires local opt-in for environment credentials and rejects control characters", () => {
    expect(agyEnvironmentKey({ GEMINI_API_KEY: key })).toBeUndefined();
    expect(agyEnvironmentKey({ ORBIS_AGY_ENABLED: "1", GEMINI_API_KEY: ` ${key} ` })).toBe(key);
    expect(agyKey(`${key}\n`)).toBeUndefined();
    expect(agyKey("a".repeat(513))).toBeUndefined();
  });

  it("verifies against the fixed official origin with a header and no redirects, never consuming an error body", async () => {
    const result = new Response(key, { status: 403 });
    const request = vi.fn<typeof fetch>().mockResolvedValue(result);
    expect(await verifyAgyKey(key, undefined, request)).toBe("rejected");
    expect(request).toHaveBeenCalledExactlyOnceWith("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
      method: "GET", headers: { "x-goog-api-key": key }, redirect: "error", signal: expect.any(AbortSignal),
    });
    expect(result.bodyUsed).toBe(true); // canceled, not read or surfaced
    expect(await verifyAgyKey(null, undefined, request)).toBe("invalid");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([[200, "verified"], [400, "rejected"], [401, "rejected"], [429, "unavailable"], [503, "unavailable"]])("classifies HTTP %i without reading its payload", async (status, expected) => {
    expect(await verifyAgyKey(key, undefined, async () => new Response(null, { status }))).toBe(expected);
  });

  it("keeps network exceptions private and aborts a revoked check", async () => {
    expect(await verifyAgyKey(key, undefined, async () => { throw new Error(`network details ${key}`); })).toBe("unavailable");
    const abort = new AbortController();
    await expect(verifyAgyKey(key, abort.signal, async () => { abort.abort(); return new Response(); })).rejects.toMatchObject({ name: "AbortError" });
  });
});
