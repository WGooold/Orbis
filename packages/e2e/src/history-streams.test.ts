import { describe, expect, it } from "vitest";
import { envelopeNonce, type EnvelopeChannel } from "@orbis/protocol";
import { DeviceHandshake, HostHandshake, E2eChannel, randomKey, toBase64Url } from "./index.js";

describe("authenticated independent history streams", () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])("device=%s host=%s preserves the common handshake", (deviceSupport, hostSupport) => {
    const psk = randomKey(), device = new DeviceHandshake(psk, deviceSupport), host = new HostHandshake(psk, hostSupport);
    const hello = device.start();
    expect(Object.keys(hello).sort()).toEqual(["ePubD", "type"]);
    const confirm = device.accept(host.acceptHello(hello));
    host.confirm(confirm);
    expect(device.keys.historyStreams === true).toBe(deviceSupport && hostSupport);
    expect(host.keys.historyStreams === true).toBe(deviceSupport && hostSupport);
    if (!deviceSupport || !hostSupport) expect(Object.keys(confirm).sort()).toEqual(["macD", "type"]);
    const sender = new E2eChannel({ keys: host.keys, role: "host" });
    const receiver = new E2eChannel({ keys: device.keys, role: "device" });
    const header = { k: "data" as const, room: "r", from: "h", to: "d", n: 1 };
    expect(receiver.open(sender.seal({ ...header, ch: "msg" }, Buffer.from("legacy chat")))?.toString()).toBe("legacy chat");
    if (!deviceSupport || !hostSupport) expect(() => sender.seal({ ...header, ch: "history" }, Buffer.from("unoffered"))).toThrow();
  });

  it("rejects forged capability, forged acceptance and cross-stream channel tampering", () => {
    const psk = randomKey(), device = new DeviceHandshake(psk, true), host = new HostHandshake(psk, true);
    const accept = host.acceptHello(device.start());
    expect(() => device.accept({ ...accept, historyMac: toBase64Url(Buffer.alloc(32)) })).toThrow();
    const confirm = device.accept(accept);
    const stripped = { type: confirm.type, macD: confirm.macD };
    expect(() => host.confirm(stripped)).toThrow();
    host.confirm(confirm);
    const sender = new E2eChannel({ keys: host.keys, role: "host" }), receiver = new E2eChannel({ keys: device.keys, role: "device" });
    const frame = sender.seal({ k: "data", room: "r", from: "h", to: "d", ch: "history", n: 1 }, Buffer.from("page"));
    expect(() => receiver.open({ ...frame, hdr: { ...frame.hdr, ch: "catchup" } })).toThrow();
    expect(receiver.open(frame)?.toString()).toBe("page");
  });

  it("delivers later live/history before earlier catchup/bulk without replay loss, retaining per-stream FIFO", () => {
    const psk = randomKey(), device = new DeviceHandshake(psk, true), host = new HostHandshake(psk, true);
    host.confirm(device.accept(host.acceptHello(device.start())));
    const sender = new E2eChannel({ keys: host.keys, role: "host" }), receiver = new E2eChannel({ keys: device.keys, role: "device" });
    const channels: EnvelopeChannel[] = ["bulk", "catchup", "history", "msg", "ctl"];
    const frames = channels.map(ch => [1, 2].map(n => sender.seal({ k: "data", room: "r", from: "h", to: "d", ch, n }, Buffer.from(`${ch}:${n}`))));
    for (const pair of frames.reverse()) for (const frame of pair) {
      expect(receiver.open(frame)?.toString()).toBe(`${frame.hdr.ch}:${frame.hdr.n}`);
      expect(receiver.open(frame)).toBeUndefined();
    }
    expect(new Set(channels.map(ch => Buffer.from(envelopeNonce(ch, 1)).toString("hex"))).size).toBe(5);
  });
});
