/**
 * 选路规则的单测（spec §6.2）。
 *
 * 规则收敛成一条：**按优先级取当前可用的最高档**。所以这里钉的是三件事：
 * - 首次选路就按优先级取最高档；
 * - 更高档的路径随后可用时当拍顶替（手动排序要真的生效）；
 * - 当前路径没了立刻取剩下最高档（不能等采样）。
 * RTT 只记录、不换路，单独钉一条防止有人又把「快 30% 才换」塞回来。
 */
import { describe, expect, it } from "vitest";

import { PathSelector, describePath, normalizePreference } from "./path.js";

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

    // P2P（默认排在 relay 前面）握手完成：立刻换过去。
    expect(selector.markAvailable("p2p")).toMatchObject({ changed: true, from: "relay", to: "p2p" });
    expect(selector.active).toBe("p2p");

    // LAN 又比 P2P 高：继续顶替。
    expect(selector.markAvailable("lan")).toMatchObject({ changed: true, from: "p2p", to: "lan" });
    expect(selector.active).toBe("lan");
  });

  it("低档路径可用不顶替当前路径", () => {
    const selector = new PathSelector();
    selector.markAvailable("lan");
    expect(selector.markAvailable("relay")).toEqual({ changed: false });
    expect(selector.active).toBe("lan");
  });

  it("改优先级顺序会当场重取最高档", () => {
    const selector = new PathSelector();
    selector.markAvailable("lan");
    selector.markAvailable("p2p");
    expect(selector.active).toBe("lan");

    // 用户把 P2P 排到第一：既然它已经可用，就立刻生效。
    expect(selector.setPreference(["p2p", "lan", "relay"])).toMatchObject({ changed: true, from: "lan", to: "p2p" });
    expect(selector.active).toBe("p2p");

    // 排回默认顺序：LAN 重新当选。
    expect(selector.setPreference(["lan", "p2p", "relay"])).toMatchObject({ changed: true, from: "p2p", to: "lan" });
    expect(selector.active).toBe("lan");
  });

  it("RTT 只记录，不触发换路", () => {
    const selector = new PathSelector();
    selector.markAvailable("relay");
    selector.markAvailable("lan");
    expect(selector.active).toBe("lan");

    // 把 relay 排到 LAN 前面：即便 LAN 的 RTT 远快于 relay，也不该把路径拉回去。
    selector.setPreference(["relay", "lan", "p2p"]);
    expect(selector.active).toBe("relay");
    for (let i = 0; i < 10; i += 1) {
      expect(selector.observeRtt("lan", 1)).toEqual({ changed: false });
    }
    expect(selector.active).toBe("relay");
    expect(selector.rttOf("lan")).toBe(1);
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

describe("normalizePreference", () => {
  it("补齐残缺顺序，丢掉未知与重复项，保证三档齐全", () => {
    expect(normalizePreference(undefined)).toEqual(["lan", "p2p", "relay"]);
    expect(normalizePreference(["p2p"] as const)).toEqual(["p2p", "lan", "relay"]);
    expect(normalizePreference(["relay", "relay", "p2p"] as const)).toEqual(["relay", "p2p", "lan"]);
  });
});

describe("describePath", () => {
  it("给用户看的名字是固定的三个词", () => {
    expect(describePath("lan")).toBe("LAN 直连");
    expect(describePath("p2p")).toBe("P2P 直连");
    expect(describePath("relay")).toBe("中继");
    expect(describePath(undefined)).toBe("无可用路径");
  });
});
