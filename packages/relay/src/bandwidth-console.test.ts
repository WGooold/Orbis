import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { RelayBandwidth } from "./bandwidth.js";

// X11 / RELAY-BW-03: exercise the shipped console's rendering logic without a browser dependency.
// This catches escaped device names, absent samples, period selection and per-device history;
// layout and real browser interactions remain a separate manual/browser check.
describe("device bandwidth console", () => {
  it("shows collected periods and history, escapes names, and distinguishes unmeasured devices", async () => {
    let now = Date.parse("2026-11-04T12:00:00Z");
    const meter = await RelayBandwidth.create({ now: () => now });
    meter.record("phone", "download", 1_000_000);
    now += 86_400_000;
    meter.record("phone", "upload", 1_000);
    meter.record("tablet", "download", 500);
    now += 1_000;
    const report = meter.snapshot();
    const fixtures = {
      ...report, storageError: true,
      devices: [...report.devices.map(device => ({ ...device, name: device.deviceId === "tablet" ? '<img src=x onerror=alert(1)>' : "回归手机", online: false, hostId: "host" })),
        { deviceId: "unused", name: "未使用的平板", online: false }],
    };
    const nodes = new Map<string, { innerHTML: string; value: string; querySelectorAll: () => never[]; onchange?: () => void; oninput?: (event: { target: { value: string } }) => void }>();
    const node = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { innerHTML: "", value: "", querySelectorAll: () => [] });
      return nodes.get(id)!;
    };
    const context = createContext({
      fixtures, URL, AbortController,
      location: { href: "http://127.0.0.1:8787/relay/admin/" },
      document: { getElementById: node, querySelector: () => null, querySelectorAll: () => [], hidden: false },
      window: { addEventListener: () => {} },
      fetch: () => new Promise(() => {}), setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    });
    const source = await readFile(new URL("./web/admin.js", import.meta.url), "utf8");
    runInContext(source, context);
    runInContext('bandwidthData = fixtures; data = {}; view = "bandwidth"; draw();', context);
    const today = node("view-content").innerHTML;
    expect(today).toContain("设备带宽");
    expect(today).toContain("读取或保存失败");
    expect(today).toContain("8.00 Kbps");
    expect(today).toContain("空闲秒不参与");
    expect(node("bandwidth-table").innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(node("bandwidth-table").innerHTML).not.toContain("<img");
    expect(node("bandwidth-table").innerHTML).toContain("待采样");
    node("bandwidth-period").value = "last7Days";
    node("bandwidth-period").onchange!();
    expect(node("view-content").innerHTML).toContain("8.00 Mbps");
    runInContext('bandwidthDevice = "phone"; drawBandwidthTable();', context);
    expect(node("bandwidth-history").innerHTML).toContain("回归手机 每日明细");
    expect(node("bandwidth-history").innerHTML).not.toContain("·");
    expect(node("bandwidth-history").innerHTML).toContain("2026-11-04");
    expect(node("bandwidth-history").innerHTML).toContain("2026-11-05");
    node("search").oninput!({ target: { value: "tablet" } });
    expect(node("bandwidth-table").innerHTML).not.toContain("回归手机");
    expect(node("bandwidth-table").innerHTML).toContain("&lt;img");
  });
});
