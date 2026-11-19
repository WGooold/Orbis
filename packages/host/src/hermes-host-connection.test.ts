import { expect, it, vi } from "vitest";
import { HermesHostConnection } from "./hermes-host-connection.js";
import type { HermesGatewayAttachment, HermesGatewayBootstrapOptions } from "./hermes-gateway-bootstrap.js";

function fixture(profile_id = "/fixture") {
  const client = { close: vi.fn(async () => undefined), closed: false, readyState: 1 };
  const endpoint = { profile_id, instance_id: "fixture", authority_epoch: 1, api_origin: "http://127.0.0.1:1",
    supervisor: "fixture", runtime_protocol: 1, capabilities: ["session-authority-v1"] };
  const attachment = { client, endpoint, serverRequests: [], runtime: { ...endpoint,
    session_create: { sources: ["tui"], parameters: ["cwd"] } } } as unknown as HermesGatewayAttachment;
  return { client, attachment };
}

// HERMES-GATEWAY-01: a failed attach is local, and a replacement must prove the same profile.
it("coalesces concurrent attach, retires dead sockets, and refuses a different profile", async () => {
  const first = fixture(), replacement = fixture("/other-profile");
  let callbacks: HermesGatewayBootstrapOptions | undefined;
  const connect = vi.fn(async (options?: HermesGatewayBootstrapOptions) => {
    callbacks = options;
    if (connect.mock.calls.length === 1) throw new Error("fixture owner unavailable");
    return connect.mock.calls.length === 2 ? first.attachment : replacement.attachment;
  });
  const changed = vi.fn();
  const host = new HermesHostConnection({ connect }, "host", changed);
  const failed = host.ensure();
  expect(host.ensure()).toBe(failed);
  await expect(failed).rejects.toThrow("fixture owner unavailable");
  expect(host.backend).toBeUndefined();
  const backend = await host.ensure();
  first.client.closed = true;
  callbacks?.onTransportError?.(new Error("fixture disconnect"));
  expect(changed).toHaveBeenLastCalledWith(undefined, backend);
  expect(host.backend).toBeUndefined();
  expect(first.client.close).toHaveBeenCalledOnce();
  await expect(host.ensure()).rejects.toThrow("profile");
  expect(callbacks?.expectedProfileId).toBe("/fixture");
  expect(replacement.client.close).toHaveBeenCalledOnce();
  await host.close();
});

it("does not wait for bootstrap during pause or attach a late socket", async () => {
  const { client, attachment } = fixture();
  let finish!: (attachment: HermesGatewayAttachment) => void;
  const connect = () => new Promise<HermesGatewayAttachment>(resolve => { finish = resolve; });
  const changed = vi.fn();
  const host = new HermesHostConnection({ connect }, "host", changed);
  const pending = host.ensure();
  await host.close();
  finish(attachment);
  await expect(pending).rejects.toThrow("已断开");
  expect(changed).not.toHaveBeenCalled();
  expect(client.close).toHaveBeenCalledOnce();
});
