import { describe, expect, it } from "vitest";

import { PathSelector, describePath } from "./path.js";

describe("PathSelector", () => {
  it("首次选路按优先级取最高档可用路径", () => {
    const selector = new PathSelector();
    expect(selector.active).toBeUndefined();

    // 先来的是 Relay（常驻控制面），它就是此刻唯一可用的。
    expect(selector.markAvailable("relay")).toMatchObject({ changed: true, from: undefined, to: "relay" });
    expect(selector.active).toBe("relay");
  });

  it("更高档的路径随后可用就当拍顶替，不等 RTT", () => {
    const selector = new PathSelector();
    selector.markAvailable("relay");

    expect(selector.markAvailable("lan")).toMatchObject({ changed: true, from: "relay", to: "lan" });
    expect(selector.active).toBe("lan");
  });

  it("低档路径可用不顶替当前路径", () => {
    const selector = new PathSelector();
    selector.markAvailable("lan");
    expect(selector.markAvailable("relay")).toEqual({ changed: false });
    expect(selector.active).toBe("lan");
  });

  it("RTT 只记录，不触发换路", () => {
    const selector = new PathSelector();
    selector.markAvailable("relay");
    selector.markAvailable("lan");
    expect(selector.active).toBe("lan");

    for (let i = 0; i < 10; i += 1) {
      expect(selector.observeRtt("relay", 1)).toEqual({ changed: false });
    }
    expect(selector.active).toBe("lan");
    expect(selector.rttOf("relay")).toBe(1);
  });

  it("当前路径消失就立刻取剩下最高档，不等采样", () => {
    const selector = new PathSelector();
    selector.markAvailable("relay");
    selector.markAvailable("lan");
    expect(selector.active).toBe("lan");

    expect(selector.markUnavailable("lan")).toMatchObject({ changed: true, from: "lan", to: "relay" });
  });

  it("全部路径都没了就是没有路径，而不是「没变化」", () => {
    const selector = new PathSelector();
    selector.markAvailable("relay");
    expect(selector.markUnavailable("relay")).toMatchObject({ changed: true, to: undefined });
    expect(selector.active).toBeUndefined();
    expect(selector.available).toEqual([]);
  });

  it("摘掉非当前路径不产生切换", () => {
    const selector = new PathSelector();
    selector.markAvailable("lan");
    selector.markAvailable("relay");
    expect(selector.markUnavailable("relay")).toEqual({ changed: false });
    expect(selector.active).toBe("lan");
  });

  it("不可用路径的采样被丢弃", () => {
    const selector = new PathSelector();
    selector.markAvailable("relay");
    expect(selector.observeRtt("lan", 1)).toEqual({ changed: false });
    expect(selector.rttOf("lan")).toBeUndefined();
  });
});

describe("describePath", () => {
  it("给用户看的名字是固定的两个词", () => {
    expect(describePath("lan")).toBe("LAN 直连");
    expect(describePath("relay")).toBe("中继");
    expect(describePath(undefined)).toBe("无可用路径");
  });
});
