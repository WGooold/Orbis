/**
 * LAN 端点的小单测（spec §4.2 的 `lan[]` / §6.1）。
 *
 * 完整链路（连接、握手、切换）在 `host-service.test.ts` 里验；这里只钉住「写进二维码的
 * 地址是怎么挑的」——它错了不会报错，只会让手机连一个到不了的地方。
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_LAN_PORT, LAN_PATH, localLanEndpoints } from "./lan-server.js";

describe("localLanEndpoints", () => {
  it("只收非回环的 IPv4", () => {
    const endpoints = localLanEndpoints(42130, {
      lo: [
        { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" },
        { address: "::1", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", mac: "00:00:00:00:00:00", internal: true, cidr: "::1/128", scopeid: 0 },
      ],
      eth0: [
        { address: "192.168.1.23", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "192.168.1.23/24" },
        { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "fe80::1/64", scopeid: 3 },
      ],
    });

    expect(endpoints).toEqual([{ host: "192.168.1.23", port: 42130 }]);
  });

  it("同一地址出现在多张网卡上时只写一条", () => {
    const entry = (address: string) => ({
      address,
      netmask: "255.255.255.0",
      family: "IPv4" as const,
      mac: "aa:bb:cc:dd:ee:ff",
      internal: false,
      cidr: `${address}/24`,
    });
    const endpoints = localLanEndpoints(1, {
      eth0: [entry("10.0.0.5")],
      vpn0: [entry("10.0.0.5"), entry("10.0.0.6")],
    });

    expect(endpoints.map((item) => item.host)).toEqual(["10.0.0.5", "10.0.0.6"]);
  });

  it("APIPA 地址不算——169.254 到不了手机，写进二维码只会白等一次连接超时", () => {
    const endpoints = localLanEndpoints(42130, {
      eth0: [
        { address: "169.254.12.34", netmask: "255.255.0.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "169.254.12.34/16" },
      ],
    });

    expect(endpoints).toEqual([]);
  });
});

describe("LAN 端点常量", () => {
  it("端口稳定、路径与 Relay 的分开", () => {
    // 端口要稳定：二维码是唯一把 LAN 地址带出电脑的通道，而 `pi-remote pair` 是短命进程，
    // 它必须能在常驻 Host 还没跑的时候就把端口写进二维码。
    expect(DEFAULT_LAN_PORT).toBe(42130);
    expect(LAN_PATH).toBe("/v1/lan");
  });
});
