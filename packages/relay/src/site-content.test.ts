import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { agentEnablementCatalog } from "../../host/src/agent-enablement.js";

const cinemaSource = readFileSync(new URL("./web/cinema.js", import.meta.url), "utf8");
const filmMarkupSource = readFileSync(new URL("./web/film-markup.js", import.meta.url), "utf8");
const filmTimelineSource = readFileSync(new URL("./web/film-timeline.js", import.meta.url), "utf8");
const relayAssetsSource = readFileSync(new URL("./web.ts", import.meta.url), "utf8");

function featuredAgents() {
  const rows = cinemaSource.match(/const agents = \[([\s\S]*?)\n\];/)?.[1];
  if (!rows) throw new Error("Website agent list was not found");
  return [...rows.matchAll(/^\s*\{ name: "([^"]+)", image: "([^"]+)"([^}\n]*)\}/gm)]
    .map(([, name, image, row]) => {
      if (!name || !image) throw new Error("Website agent entry is incomplete");
      return { name, image, preview: /preview:\s*true/.test(row ?? "") };
    });
}

describe("public website content", () => {
  it("keeps the website agent carousel aligned with the current Host catalog", () => {
    const agents = featuredAgents();
    const websiteNameByKind: Record<keyof typeof agentEnablementCatalog, string> = {
      codex: "Codex", codexDesktop: "Codex Desktop", claude: "Claude Code", dsh: "DeepSeek",
      dshDesktop: "DeepSeek", pi: "Pi", kimiCode: "Kimi Code", kimiCodeDesktop: "Kimi Code",
      opencode: "OpenCode", agy: "Antigravity", hermes: "Hermes", openclaw: "OpenClaw",
    };
    const activeCatalogNames = [...new Set((Object.keys(agentEnablementCatalog) as Array<keyof typeof agentEnablementCatalog>)
      .map(kind => websiteNameByKind[kind]))].sort();
    expect(agents.filter(agent => !agent.preview).map(agent => agent.name).sort()).toEqual(activeCatalogNames);
    expect(agents.filter(agent => agent.preview).map(agent => agent.name)).toEqual(["Oh My Pi"]);

    const context = { window: {} as { OrbisFilmMarkup?: { s3?: string } } };
    runInNewContext(filmMarkupSource, context);
    const film = context.window.OrbisFilmMarkup?.s3;
    expect(film).toBeTypeOf("string");
    if (!film) throw new Error("Website agent film markup was not built");
    const filmLabels = [...film.matchAll(/class="s3-name" id="s3-n\d+"><i class="agent [^"]+"><\/i>([^<]*)<\/div>/g)]
      .map(([, name]) => name);
    expect(filmLabels).toEqual(agents.map(agent => agent.name === "Codex Desktop" ? "Codex 桌面版" : agent.name));
    expect(agents.find(agent => agent.name === "Antigravity")?.image).toBe("antigravity.svg");
    expect(filmMarkupSource).toContain("a-antigravity");
    expect(filmTimelineSource).toContain('{ name: "Antigravity", icon: "a-antigravity" }');
    expect(filmTimelineSource).not.toContain("ZCode");
    expect(relayAssetsSource).toContain('"/assets/promo/agents/antigravity.svg"');
    expect(existsSync(new URL("./web/promo/agents/antigravity.svg", import.meta.url))).toBe(true);
  });

  it("keeps supporting site and Windows Host docs current", () => {
    const promoGuide = readFileSync(new URL("./web/promo/README.md", import.meta.url), "utf8");
    expect(promoGuide).toContain("only Oh My Pi is labelled");
    expect(promoGuide).not.toContain("Six planned Agents");

    const hostGuide = readFileSync(new URL("../../../packages/windows-host/README.md", import.meta.url), "utf8");
    for (const agent of ["Kimi Code Web/Desktop", "OpenCode", "Antigravity CLI", "Hermes Agent", "OpenClaw"]) {
      expect(hostGuide).toContain(agent);
    }
    expect(hostGuide).not.toContain("Pi/Codex/DeepSeek Harness on the Agent page");
  });
});
