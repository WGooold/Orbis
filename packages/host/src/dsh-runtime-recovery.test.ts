import { afterEach, describe, expect, it, vi } from "vitest";
import { DshRuntime } from "./dsh-runtime.js";
import { DshWebClient, type DshWebConnection } from "./dsh-web-client.js";
import * as services from "./dsh-web-service.js";
import * as provider from "./dsh-web-provider.js";
import * as history from "./dsh-web-history.js";

afterEach(() => { vi.restoreAllMocks(); });

function fixture() {
  const env = { DSH_HOME: "/isolated-dsh", ORBIS_DSH_PROVIDER_ENV: '{"DEEPSEEK_API_KEY":"fixture-only"}' };
  const service = { url: "http://127.0.0.1:3080/?token=fixture-only-launch-token", stop: vi.fn(async () => {}),
    cli: { command: process.execPath, prefixArgs: ["/isolated-dsh/bin.js"] } };
  const client: DshWebConnection = {
    onEvent: undefined, onExit: undefined, onReconnect: undefined,
    request: vi.fn(async () => ({})) as DshWebConnection["request"],
    subscribe: vi.fn(() => () => {}), respondEvent: vi.fn(async () => {}), stop: vi.fn(async () => {}),
  };
  const find = vi.spyOn(services, "findDshWebService").mockResolvedValue(service);
  const ensure = vi.spyOn(services, "ensureDshWebService").mockResolvedValue(service);
  const connect = vi.spyOn(DshWebClient, "connect").mockResolvedValue(client as DshWebClient);
  const apply = vi.spyOn(provider, "applyDshWebProvider").mockResolvedValue(undefined);
  const decoder = vi.spyOn(history, "loadDshStreamDecoder").mockResolvedValue(() => []);
  return { env, service, client, find, ensure, connect, apply, decoder };
}

describe("DSH existing-service connection factory", () => {
  it("returns absent without launching a service or opening a Web connection", async () => {
    const f = fixture(); f.find.mockResolvedValue(undefined);
    expect(await DshRuntime.connectExisting(f.env)).toBeUndefined();
    expect(f.ensure).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("uses the discovered CLI and authenticated handshake without changing provider credentials or Sessions", async () => {
    const f = fixture();
    const runtime = await DshRuntime.connectExisting(f.env);
    try {
      expect(runtime?.isReady()).toBe(true);
      expect(f.connect).toHaveBeenCalledWith({ url: f.service.url, env: f.env, cli: f.service.cli });
      expect(f.decoder).toHaveBeenCalledWith("/isolated-dsh/bin.js");
      expect(f.ensure).not.toHaveBeenCalled();
      expect(f.apply).not.toHaveBeenCalled();
      expect(f.client.request).not.toHaveBeenCalled();
    } finally { await runtime?.stop(); }
    expect(f.client.stop).toHaveBeenCalledTimes(1);
    expect(f.service.stop).not.toHaveBeenCalled();
  });

  it("does not report a runtime when the Web handshake fails", async () => {
    const f = fixture(); f.connect.mockRejectedValue(new Error("handshake rejected"));
    await expect(DshRuntime.connectExisting(f.env)).rejects.toThrow("handshake rejected");
    expect(f.decoder).not.toHaveBeenCalled();
    expect(f.ensure).not.toHaveBeenCalled();
  });

  it("closes its client when loading the matching native decoder fails", async () => {
    const f = fixture(); f.decoder.mockRejectedValue(new Error("native decoder missing"));
    await expect(DshRuntime.connectExisting(f.env)).rejects.toThrow("native decoder missing");
    expect(f.client.stop).toHaveBeenCalledTimes(1);
    expect(f.ensure).not.toHaveBeenCalled();
  });

  it("keeps provider initialization on the explicit launch path", async () => {
    const f = fixture();
    const runtime = await DshRuntime.create(f.env);
    try {
      expect(f.ensure).toHaveBeenCalledWith(f.env);
      expect(f.apply).toHaveBeenCalledWith(f.client, f.env);
      expect(f.find).not.toHaveBeenCalled();
    } finally { await runtime.stop(); }
  });
});
