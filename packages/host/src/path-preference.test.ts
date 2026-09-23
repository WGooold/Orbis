/**
 * 设备连接优先级载荷的校验（§6.2 的本机扩展）。
 *
 * 关键不变量：只有「lan/p2p/relay 的一个完整排列」才被接受。残缺或重复的顺序如果放进去，
 * 选路器会悄悄补全，用户看到的是「排好了」，实际生效的是别的顺序——比没有设置更难查。
 */
import { describe, expect, it } from "vitest";

import { parsePathPreferenceMessage } from "./path-preference.js";

describe("parsePathPreferenceMessage", () => {
  it("接受三档的任意排列", () => {
    expect(parsePathPreferenceMessage({ type: "device.pathPreference", preference: ["p2p", "lan", "relay"] }))
      .toMatchObject({ type: "device.pathPreference", preference: ["p2p", "lan", "relay"] });
    expect(parsePathPreferenceMessage({ type: "device.pathPreference", preference: ["relay", "p2p", "lan"] }))
      .toMatchObject({ preference: ["relay", "p2p", "lan"] });
  });

  it("拒绝残缺、重复或未知成员，以及根本不是这条消息的载荷", () => {
    expect(parsePathPreferenceMessage({ type: "device.pathPreference", preference: ["p2p", "lan"] })).toBeUndefined();
    expect(parsePathPreferenceMessage({ type: "device.pathPreference", preference: ["p2p", "p2p", "lan"] })).toBeUndefined();
    expect(parsePathPreferenceMessage({ type: "device.pathPreference", preference: ["p2p", "lan", "wan"] })).toBeUndefined();
    expect(parsePathPreferenceMessage({ type: "device.pathPreference" })).toBeUndefined();
    expect(parsePathPreferenceMessage({ type: "session.list" })).toBeUndefined();
    expect(parsePathPreferenceMessage(undefined)).toBeUndefined();
  });
});
