import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const siteSource = readFileSync(new URL("./web/site.js", import.meta.url), "utf8");
const downloadSource = siteSource.slice(0, siteSource.indexOf("void loadDownloads();"));

class MockElement {
  tag: string;
  className = "";
  textContent = "";
  href = "";
  value = "";
  hidden = false;
  attributes: Record<string, string> = {};
  children: Array<MockElement | string> = [];
  classes = new Set<string>();
  events: Record<string, (event: any) => void> = {};
  classList = {
    toggle: (name: string, force?: boolean) => {
      if (force === undefined) {
        if (this.classes.has(name)) this.classes.delete(name); else this.classes.add(name);
      } else if (force) this.classes.add(name); else this.classes.delete(name);
    },
    remove: (name: string) => { this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
  };
  constructor(tag = "div") { this.tag = tag; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, fn: (event: any) => void) { this.events[name] = fn; }
  append(...items: Array<MockElement | string>) { this.children.push(...items); }
  replaceChildren(...items: Array<MockElement | string>) { this.children = [...items]; }
  allText(): string {
    return this.children.length > 0
      ? this.children.map(item => typeof item === "string" ? item : item.allText()).join("")
      : this.textContent;
  }
}

const sampleSiteData = {
  windows: [
    { name: "OrbisHost-0.1.24-windows-x64-setup.exe", url: "downloads/OrbisHost-0.1.24-windows-x64-setup.exe", checksumUrl: "downloads/OrbisHost-0.1.24-windows-x64-setup.exe.sha256", bytes: 15728640 },
    { name: "OrbisHost-0.1.24-windows-x64.zip", url: "downloads/OrbisHost-0.1.24-windows-x64.zip", checksumUrl: "downloads/OrbisHost-0.1.24-windows-x64.zip.sha256", bytes: 14680064 },
  ],
  macos: [
    { name: "OrbisHost-0.1.24-macos-arm64.dmg", url: "downloads/OrbisHost-0.1.24-macos-arm64.dmg", checksumUrl: "downloads/OrbisHost-0.1.24-macos-arm64.dmg.sha256", bytes: 18874368 },
    { name: "OrbisHost-0.1.24-macos-x64.dmg", url: "downloads/OrbisHost-0.1.24-macos-x64.dmg", checksumUrl: "downloads/OrbisHost-0.1.24-macos-x64.dmg.sha256", bytes: 19922944 },
  ],
  android: "https://orbising.com/downloads/orbis.apk",
  androidVersion: "0.1.49",
  ios: "https://testflight.apple.com/join/9zGP1NZX",
};

async function runDownloads(nav: Record<string, any>, apiData: any = sampleSiteData) {
  const elements: Record<string, MockElement> = {
    "device-recommendation": new MockElement("p"),
    "host-card": new MockElement("article"),
    "app-card": new MockElement("article"),
    "host-recommend": new MockElement("span"),
    "app-recommend": new MockElement("span"),
    "host-platform": new MockElement("select"),
    "app-platform": new MockElement("select"),
    "host-requirement": new MockElement("p"),
    "app-requirement": new MockElement("p"),
    "host-version": new MockElement("span"),
    "app-version": new MockElement("span"),
    "host-downloads": new MockElement("div"),
    "app-downloads": new MockElement("div"),
  };
  elements["device-recommendation"]!.hidden = true;
  elements["host-recommend"]!.hidden = true;
  elements["app-recommend"]!.hidden = true;
  elements["host-platform"]!.value = "windows";
  elements["app-platform"]!.value = "android";

  const context: Record<string, any> = {
    navigator: nav,
    document: {
      getElementById: (id: string) => elements[id],
      createElement: (tag: string) => new MockElement(tag),
    },
    fetch: async () => apiData
      ? { ok: true, json: async () => apiData }
      : { ok: false, json: async () => ({}) },
  };
  runInNewContext(`${downloadSource}\nthis.loadDownloads = loadDownloads;`, context);
  await context.loadDownloads();
  return elements;
}

describe("public site download cards and device recommendation", () => {
  it("omits SHA-256, portable ZIP, and redundant instructional copy", async () => {
    const html = readFileSync(new URL("./web/index.html", import.meta.url), "utf8");
    expect(html).not.toContain('id="host-detail"');
    expect(html).not.toContain('id="host-note"');
    expect(html).not.toContain('id="app-detail"');
    expect(html).not.toContain('id="app-note"');

    const el = await runDownloads({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" });
    const hostLinks = el["host-downloads"]!.children as MockElement[];
    expect(hostLinks).toHaveLength(1);
    expect(hostLinks[0]!.href).toBe("downloads/OrbisHost-0.1.24-windows-x64-setup.exe");
    expect(hostLinks[0]!.textContent).toBe("下载 Windows 版（15 MB）");

    const appLinks = el["app-downloads"]!.children as MockElement[];
    expect(appLinks).toHaveLength(1);
    expect(appLinks[0]!.href).toBe("https://orbising.com/downloads/orbis.apk");
    expect(appLinks[0]!.textContent).toBe("下载 Android 版");
  });

  it("recommends and selects the matching platform for Windows, macOS Silicon, Android, and iOS", async () => {
    const macArm = await runDownloads({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      platform: "MacIntel",
      userAgentData: { getHighEntropyValues: async () => ({ architecture: "arm" }) },
    });
    expect(macArm["host-platform"]!.value).toBe("macos-arm64");
    expect(macArm["device-recommendation"]!.hidden).toBe(false);
    expect(macArm["device-recommendation"]!.allText()).toContain("Orbis Host（macOS，Apple Silicon）");
    expect(macArm["host-card"]!.classList.contains("is-recommended")).toBe(true);
    expect(macArm["host-recommend"]!.hidden).toBe(false);
    expect(macArm["app-recommend"]!.hidden).toBe(true);

    const ios = await runDownloads({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    expect(ios["app-platform"]!.value).toBe("ios");
    expect(ios["device-recommendation"]!.allText()).toContain("Orbis App（iOS）");
    expect(ios["app-card"]!.classList.contains("is-recommended")).toBe(true);
    expect(ios["host-card"]!.classList.contains("is-recommended")).toBe(false);

    const android = await runDownloads({
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)",
      platform: "Linux armv8l",
    });
    expect(android["app-platform"]!.value).toBe("android");
    expect(android["device-recommendation"]!.allText()).toContain("Orbis App（Android）");
    expect(android["app-card"]!.classList.contains("is-recommended")).toBe(true);
  });

  it("falls back to default Windows selection if macOS release is not published yet", async () => {
    const macNoRelease = await runDownloads(
      { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel" },
      { ...sampleSiteData, macos: [] },
    );
    expect(macNoRelease["host-platform"]!.value).toBe("windows");
    expect(macNoRelease["host-version"]!.textContent).toBe("预览版 0.1.24");
    expect(macNoRelease["device-recommendation"]!.allText()).toContain("Orbis Host（macOS）");
  });
});
