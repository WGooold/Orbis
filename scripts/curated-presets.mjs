/** Orbis ships presets for model vendors, major platforms and local runtimes only; API resellers and referral links stay out. */
const categories = new Set(["official", "cn_official", "local"]);
// Major platforms the upstream catalog files elsewhere. Additions are reviewed by name.
const platforms = new Set([
  "xAI (Grok)", "Azure OpenAI", "Microsoft Foundry", "AWS Bedrock", "AWS Bedrock (AKSK)", "AWS Bedrock (API Key)", "Cloudflare AI Gateway",
  "OpenRouter", "SiliconFlow", "SiliconFlow en", "ModelScope", "Nvidia", "Groq", "Hugging Face", "Vercel AI Gateway",
  "Ollama Cloud", "OpenCode Go", "OpenCode Zen",
]);
// Vendor services whose product name alone does not say whose they are.
const names = new Map([
  ["StreamLake", "快手 StreamLake"], ["StreamLake en", "快手 StreamLake（国际）"], ["KAT-Coder", "快手 KAT-Coder"], ["Longcat", "美团 LongCat"],
  ["BaiLing", "蚂蚁百灵"], ["BytePlus", "字节跳动 BytePlus"], ["Astron Coding Plan", "讯飞 Astron Coding Plan"],
]);
const referral = /^(?:aff|ref|referrer|referral|rc|ic|ac|invite|invited_by|invitation|channel|track_id|cps_key|ytag)$|^utm_/iu;
export function curatedPresets(presets) {
  return presets.filter(preset => categories.has(preset.category) || platforms.has(preset.name)).map(source => {
    const preset = names.has(source.name) ? { ...source, name: names.get(source.name) } : source;
    const url = URL.parse(preset.websiteUrl);
    if (!url) return preset;
    const keys = [...url.searchParams.keys()].filter(key => referral.test(key));
    if (!keys.length) return preset;
    for (const key of keys) url.searchParams.delete(key);
    return { ...preset, websiteUrl: url.toString() };
  });
}
