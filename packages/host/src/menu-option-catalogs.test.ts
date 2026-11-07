// FT-G05: real long-tree data must remain complete while every page is bounded;
// exact scope/generation/catalog/value validation prevents same-name misdispatch.
import { describe, expect, it } from "vitest";
import { MenuOptionsPageSchema, type MenuOptionsRequest } from "@orbis/protocol";
import { MenuOptionCatalogs } from "./menu-option-catalogs.js";

const options = Array.from({ length: 2_009 }, (_, i) => ({ value: `native:${i}`, label: `节点 ${i}`, tree: {
  parentId: i ? `native:${i - 1}` : null, entryType: "message", role: i % 2 ? "assistant" : "user",
  defaultHidden: i % 2 === 0, isCurrent: i === 2008, isOnActivePath: true,
} }));
const commands = { tree: { name: "tree", source: "builtin", argument: { kind: "tree", required: true, options } } };
const project = (catalogs: MenuOptionCatalogs, scope = "host:pi:session", generation = "gen-1", value = commands) =>
  catalogs.project(scope, generation, value) as Record<string, { argument: { optionCatalog: { id: string; count: number }; options?: unknown[] } }>;
const request = (catalogId: string, cursor: string | null = null): MenuOptionsRequest => ({ type: "agent.menu.options.read", protocolVersion: 19,
  requestId: "read", runtimeId: "pi:runtime", commandName: "tree", catalogId, cursor });

describe("FT-G05 menu option catalogs", () => {
  it("moves all 2,009 options behind a tiny descriptor and reconstructs exact bounded pages", () => {
    const catalogs = new MenuOptionCatalogs(), compact = project(catalogs);
    const ref = compact.tree!.argument.optionCatalog;
    expect(ref.count).toBe(2_009); expect(compact.tree!.argument).not.toHaveProperty("options");
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(512);
    const collected: typeof options = [];
    let cursor: string | null = null, pages = 0;
    do {
      const page = catalogs.read("host:pi:session", request(ref.id, cursor));
      expect(MenuOptionsPageSchema.safeParse(page).success).toBe(true);
      expect(page.error).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024);
      expect(page.options.length).toBeLessThanOrEqual(200);
      collected.push(...page.options as typeof options); cursor = page.nextCursor; pages++;
    } while (cursor);
    expect(collected).toEqual(options); expect(pages).toBeGreaterThan(10);
    expect(commands.tree.argument.options).toEqual(options);
    console.info("FT-G05 synthetic menu", { before: Buffer.byteLength(JSON.stringify(commands)), after: Buffer.byteLength(JSON.stringify(compact)), pages });
  });

  it("binds cursors and selected values to the exact scope, command, content and generation", () => {
    const catalogs = new MenuOptionCatalogs(), id = project(catalogs).tree!.argument.optionCatalog.id;
    const first = catalogs.read("host:pi:session", request(id));
    expect(catalogs.valid("host:pi:session", "tree", id, "native:2008")).toBe(true);
    expect(catalogs.valid("other-host:pi:session", "tree", id, "native:2008")).toBe(false);
    expect(catalogs.valid("host:pi:session", "tree", id, "same label")).toBe(false);
    const nextId = project(catalogs, "host:pi:session", "gen-2").tree!.argument.optionCatalog.id;
    expect(nextId).not.toBe(id);
    expect(catalogs.read("host:pi:session", request(id, first.nextCursor)).error).toBe("catalog_changed");
    expect(catalogs.read("host:pi:session", request(nextId, first.nextCursor)).error).toBe("invalid_cursor");
    expect(catalogs.valid("host:pi:session", "tree", id, "native:2008")).toBe(false);
    expect(catalogs.read("missing", request(nextId)).error).toBe("unavailable");
    catalogs.release("host:pi:session");
    expect(catalogs.read("host:pi:session", request(nextId)).error).toBe("unavailable");
  });

  it("rejects malformed and out-of-range cursors without skipping items", () => {
    const catalogs = new MenuOptionCatalogs(), id = project(catalogs).tree!.argument.optionCatalog.id;
    for (const raw of ["not-json", JSON.stringify([id, -1]), JSON.stringify([id, 1.5]), JSON.stringify([id, 2009]), JSON.stringify([id, 0, true])]) {
      expect(catalogs.read("host:pi:session", request(id, Buffer.from(raw).toString("base64url"))).error).toBe("invalid_cursor");
    }
  });

  it("keeps small static selects inline and retires vanished dynamic commands", () => {
    const catalogs = new MenuOptionCatalogs();
    const input = { model: { name: "model", argument: { kind: "select", required: true, options: [{ value: "exact", label: "Name" }] } } };
    expect(catalogs.project("scope", "epoch", input)).toEqual(input);
    const id = project(catalogs).tree!.argument.optionCatalog.id;
    catalogs.project("host:pi:session", "gen-1", {});
    expect(catalogs.valid("host:pi:session", "tree", id, "native:0")).toBe(false);
  });
});
