import { describe, expect, it, vi } from "vitest";
import { cleanVoiceTranscript } from "./voice-cleanup.js";

// FT-VOICE-PROVIDER-01: selected model and current transcript are passed to the configured API, never redirected.
describe("voice cleanup provider", () => {
  it.each([
    ["openai-completions", "/v1/chat/completions", { choices: [{ message: { content: "Cleaned" } }] }],
    ["openai-responses", "/v1/responses", { output: [{ type: "message", content: [{ type: "output_text", text: "Cleaned" }] }] }],
    ["anthropic-messages", "/v1/messages", { content: [{ type: "text", text: "Cleaned" }] }],
  ])("calls the saved %s API", async (api, path, result) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
    await expect(cleanVoiceTranscript({ api, apiKey: "host-key", baseUrl: "https://vendor.test/v1", model: "default", providerKey: "p" },
      "selected", "Um, transcript", send)).resolves.toBe("Cleaned");
    const [url, req] = send.mock.calls[0]!;
    expect(String(url)).toBe(`https://vendor.test${path}`);
    expect(req?.redirect).toBe("error");
    const headers = new Headers(req?.headers);
    expect(api === "anthropic-messages" ? headers.get("x-api-key") : headers.get("authorization")).toContain("host-key");
    expect(JSON.parse(String(req?.body))).toMatchObject({ model: "selected" });
    expect(req?.body).toContain("Um, transcript");
    expect(req?.body).not.toContain("host-key");
  });
});
