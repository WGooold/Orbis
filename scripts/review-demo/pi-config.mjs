import { join } from "node:path";
import { writeFile } from "node:fs/promises";

export async function configurePi(agentDir) {
  // This is the same local-channel opt-in used by the normal Host installer.
  await writeFile(join(agentDir, "remote-control.json"), JSON.stringify({ orbisLocalEnabled: true }), { mode: 0o600 });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "review-deepseek": {
    baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKey: "$DEEPSEEK_API_KEY",
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [{ id: "deepseek-flash", name: "DeepSeek Flash (Review)", reasoning: false, input: ["text"],
      contextWindow: 1048576, maxTokens: 393216, samplingParams: { thinking: { type: "disabled" } } }],
  } } }), { mode: 0o600 });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "review-deepseek", defaultModel: "deepseek-flash", defaultThinkingLevel: "off",
    enableInstallTelemetry: false, enableAnalytics: false,
  }), { mode: 0o600 });
}
