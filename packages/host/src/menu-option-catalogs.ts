import { createHash } from "node:crypto";
import { PROTOCOL_VERSION, type MenuOptionsRequest, type MenuOptionsPage, type RuntimeSlashCommandOption } from "@orbis/protocol";

type Catalog = { id: string; options: RuntimeSlashCommandOption[] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** FT-G05: current inventories only; no process-wide cache keyed by a display name.
 * The id binds exact Host/agent/session, producer generation, command and contents.
 * Cursors cannot continue against a changed catalog or a different scope.
 */
export class MenuOptionCatalogs {
  readonly #scopes = new Map<string, Map<string, Catalog>>();
  project(scope: string, generation: string, value: unknown): unknown {
    if (!object(value)) return value;
    const catalogs = new Map<string, Catalog>();
    const result = Object.fromEntries(Object.entries(value).map(([key, command]) => {
      if (!object(command) || !object(command.argument) || !Array.isArray(command.argument.options)) return [key, command];
      const options = command.argument.options as RuntimeSlashCommandOption[];
      if (command.argument.kind !== "tree" && options.length <= 50 && Buffer.byteLength(JSON.stringify(options)) <= 8 * 1024) return [key, command];
      const id = createHash("sha256").update(JSON.stringify([scope, generation, key, options])).digest("base64url");
      catalogs.set(key, { id, options });
      const argument: Record<string, unknown> = { ...command.argument, optionCatalog: { id, count: options.length } };
      delete argument.options;
      const projected: Record<string, unknown> = { ...command, argument };
      // These are aliases of the argument contract in the released model shape.
      for (const alias of ["argumentKind", "argumentRequired", "optionCount"]) delete projected[alias];
      return [key, projected];
    }));
    this.#scopes.set(scope, catalogs);
    return result;
  }

  release(scope: string): void { this.#scopes.delete(scope); }
  clear(): void { this.#scopes.clear(); }

  valid(scope: string, name: string, id: string, value: string): boolean {
    const catalog = this.#scopes.get(scope)?.get(name);
    return catalog?.id === id && catalog.options.some(option => option.value === value);
  }

  read(scope: string | undefined, request: MenuOptionsRequest): MenuOptionsPage {
    const page: MenuOptionsPage = { type: "agent.menu.options.page", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId,
      runtimeId: request.runtimeId, commandName: request.commandName, catalogId: request.catalogId, options: [], nextCursor: null, totalCount: 0 };
    const catalog = scope === undefined ? undefined : this.#scopes.get(scope)?.get(request.commandName);
    if (!catalog) return { ...page, error: "unavailable" };
    if (catalog.id !== request.catalogId) return { ...page, error: "catalog_changed" };
    page.totalCount = catalog.options.length;
    let offset = 0;
    if (request.cursor !== null) {
      try {
        const decoded: unknown = JSON.parse(Buffer.from(request.cursor, "base64url").toString());
        if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== catalog.id || !Number.isSafeInteger(decoded[1]) || decoded[1] < 0 || decoded[1] >= catalog.options.length) throw new Error();
        offset = decoded[1] as number;
      } catch { return { ...page, error: "invalid_cursor" }; }
    }
    let bytes = Buffer.byteLength(JSON.stringify(page)) + 512;
    while (offset < catalog.options.length && page.options.length < 200) {
      const option = catalog.options[offset]!;
      const size = Buffer.byteLength(JSON.stringify(option)) + 1;
      if (bytes + size > 32 * 1024 && page.options.length) break;
      if (bytes + size > 64 * 1024) return { ...page, options: [], error: "item_too_large" };
      page.options.push(option); bytes += size; offset++;
    }
    if (offset < catalog.options.length) page.nextCursor = Buffer.from(JSON.stringify([catalog.id, offset])).toString("base64url");
    return page;
  }
}
