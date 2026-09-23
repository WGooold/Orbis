import { describe, expect, it } from "vitest";

import { parseRotateSeconds } from "./host-pair-args.mjs";

/**
 * 回归：`node scripts/host-pair.mjs --codex` 曾经把 `--codex` 当秒数解析成 NaN，
 * `setInterval(fn, NaN)` ≈ 1ms，配对码每秒轮换上千次（每次 relay HTTP + 生成 PNG），
 * 事件循环被占满 → 手机上 `session.list` 从 25ms 涨到 20 多秒。
 */
describe("host-pair 轮换秒数解析", () => {
  it("没给位置参数时用默认 240s", () => {
    expect(parseRotateSeconds(["node", "host-pair.mjs"])).toBe(240);
  });

  it("`--codex` 开关不会被当成秒数（NaN 回归）", () => {
    const seconds = parseRotateSeconds(["node", "host-pair.mjs", "--codex"]);
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBe(240);
  });

  it("`--codex` 与秒数同时给时取秒数", () => {
    expect(parseRotateSeconds(["node", "host-pair.mjs", "--codex", "600"])).toBe(600);
    expect(parseRotateSeconds(["node", "host-pair.mjs", "90", "--codex"])).toBe(90);
  });

  it("非法秒数回退默认值，绝不允许 NaN/0/负数进 setInterval", () => {
    for (const bad of ["abc", "0", "-5", "", "1e999"]) {
      const seconds = parseRotateSeconds(["node", "host-pair.mjs", bad]);
      expect(Number.isFinite(seconds)).toBe(true);
      expect(seconds).toBeGreaterThan(0);
    }
  });
});
