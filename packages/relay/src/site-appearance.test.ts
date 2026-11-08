import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Exercise production event handlers without the unrelated downloads/network startup.
const fullSource = readFileSync(new URL("./web/site.js", import.meta.url), "utf8");
const source = fullSource.slice(fullSource.indexOf("function initAppearance()"));
class Element {
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  events: Record<string, (event: any) => void> = {};
  preview?: Element;
  open = false;
  checked = false;
  focused = false;
  content = "";
  textContent = "";
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, fn: (event: any) => void) { this.events[name] = fn; }
  querySelector() { return this.preview; }
  closest() { return this; }
  focus() { this.focused = true; }
}
function harness(stored: string | null = null, storageDenied = false, reducedMotion = false) {
  const root = new Element(), menu = new Element(), summary = new Element(), follow = new Element(), systemLabel = new Element(), meta = new Element();
  const modes = ["light", "dark"].map(mode => { const el = new Element(); el.dataset.mode = mode; el.preview = new Element(); return el; });
  const materials = ["mist", "sage"].map(material => { const el = new Element(); el.dataset.material = material; el.preview = new Element(); return el; });
  const scheme = { matches: false, changed: () => {}, addEventListener(_event: string, listener: () => void) { this.changed = listener; } };
  const documentEvents: Record<string, (event: any) => void> = {};
  let transitions = 0;
  const document = {
    documentElement: root,
    getElementById(id: string) { return ({ "appearance-menu": menu, "appearance-follow": follow, "appearance-system": systemLabel } as Record<string, Element>)[id]; },
    querySelector() { return meta; },
    addEventListener(name: string, fn: (event: any) => void) { documentEvents[name] = fn; },
    startViewTransition(fn: () => void) { transitions++; fn(); },
  };
  Object.assign(menu, {
    querySelectorAll(selector: string) { return selector.includes("data-mode") ? modes : materials; },
    querySelector() { return summary; },
    contains(target: Element) { return target === menu || modes.includes(target) || materials.includes(target); },
  });
  runInNewContext(source, {
    document,
    window: {
      matchMedia: (query: string) => query.includes("reduced") ? { matches: reducedMotion } : scheme,
      localStorage: {
      getItem() { if (storageDenied) throw new Error("denied"); return stored; },
      setItem(_key: string, value: string) { if (storageDenied) throw new Error("denied"); stored = value; },
    },
      getComputedStyle: () => ({ getPropertyValue: () => "#e6ebf4" }),
    },
  });
  return { root, menu, summary, follow, modes, materials, scheme, documentEvents, stored: () => stored, transitions: () => transitions };
}

describe("public site appearance", () => {
  it("follows live system changes until an explicit preview is selected", () => {
    const app = harness();
    expect(app.root.dataset.ob).toBe("light");
    app.scheme.matches = true; app.scheme.changed();
    expect(app.root.dataset.ob).toBe("dark");
    expect(app.modes[1]!.attributes["aria-pressed"]).toBe("true");
    app.menu.events.click!({ target: app.modes[0] });
    expect(app.follow.checked).toBe(false);
    app.scheme.changed();
    expect(app.root.dataset.ob).toBe("light");
    app.menu.events.click!({ target: app.materials[1] });
    expect(app.root.dataset.ob).toBe("sage-light");
    expect(JSON.parse(app.stored()!)).toEqual({ material: "sage", mode: "light" });
    expect(app.transitions()).toBe(2);
  });
  it("restores the selected material and mode and exposes keyboard dismissal", () => {
    const app = harness('{"material":"sage","mode":"dark"}');
    expect(app.root.dataset.ob).toBe("sage-dark");
    expect(app.materials[1]!.attributes["aria-pressed"]).toBe("true");
    app.menu.open = true; app.menu.events.keydown!({ key: "Escape" });
    expect(app.menu.open).toBe(false);
    expect(app.summary.focused).toBe(true);
    app.menu.open = true; app.documentEvents.pointerdown!({ target: new Element() });
    expect(app.menu.open).toBe(false);
  });
  it("keeps working without storage and skips transitions for reduced motion", () => {
    const app = harness(null, true, true);
    app.menu.events.click!({ target: app.materials[1] });
    expect(app.root.dataset.ob).toBe("sage-light");
    expect(app.transitions()).toBe(0);
    app.scheme.matches = true; app.scheme.changed();
    expect(app.root.dataset.ob).toBe("sage-dark");
  });
  it("ignores invalid stored values and lets the system switch take effect", () => {
    const app = harness('{"material":"unknown","mode":"night"}');
    expect(app.root.dataset.ob).toBe("light");
    app.menu.events.click!({ target: app.modes[1] });
    app.follow.checked = true; app.follow.events.change!({});
    expect(app.root.dataset.ob).toBe("light");
    expect(JSON.parse(app.stored()!).mode).toBe("system");
  });
});
