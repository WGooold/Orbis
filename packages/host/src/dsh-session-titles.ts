type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
type TitleState = { title: string | null; seq: number; kind: "cached" | "sequenced" };

/** Native list hints and control/follow projections have distinct sequence spaces. */
export class DshSessionTitles {
  readonly #titles = new Map<string, TitleState>();
  generation = 0;

  apply(id: string, raw: unknown, kind: TitleState["kind"] = "sequenced", complete = false): boolean {
    const baseline = object(raw); const values = object(baseline.values);
    const value = complete && !Object.hasOwn(values, "title") ? null : values.title;
    if (!Number.isSafeInteger(baseline.asOfSeq) || Number(baseline.asOfSeq) < -1 || value !== null && typeof value !== "string") return false;
    const previous = this.#titles.get(id);
    if (previous && (previous.kind === "sequenced" && kind === "cached" || previous.kind === kind && previous.seq > Number(baseline.asOfSeq))) return false;
    const title = typeof value === "string" ? value.trim().slice(0, 256) || null : null;
    this.#titles.set(id, { title, seq: Number(baseline.asOfSeq), kind });
    return previous?.title !== title;
  }

  read(id: string, row: Obj): string | null | undefined {
    const hints = object(row.projections);
    if (hints.kind === "cached" || hints.kind === "sequenced") this.apply(id, hints, hints.kind);
    return this.#titles.get(id)?.title ?? (this.#titles.has(id) ? null : typeof row.title === "string" ? row.title.trim().slice(0, 256) || null : undefined);
  }

  reconnect(): void {
    // Old live watermarks cannot fence a replacement native connection's baseline.
    ++this.generation;
    this.#titles.clear();
  }
}
