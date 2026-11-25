import { GatewayClientRequestError } from "@openclaw/gateway-client";
import { expect, test, vi } from "vitest";
import type { OpenClawSettingsConnection } from "./openclaw-gateway.js";
import { OpenClawNativeSettings } from "./openclaw-native-settings.js";

const snapshot = { hash: "fixture-r1", valid: true, raw: "native-secret-fixture", sourceConfig: {
  agents: { defaults: { model: "fixture/one", workspace: "/fixtures/workspace", thinkingDefault: "low" } },
  tools: { deny: ["browser"], exec: { mode: "ask" } }, gateway: { auth: { token: "native-secret-fixture" } },
  models: { providers: { fixture: { apiKey: "native-secret-fixture" } } },
} };

// OPENCLAW-HOST-SETTINGS-01: only supported fields cross the bridge; PATCH changes only those leaves.
test("projects a redacted form and patches the exact revision and changed leaves", async () => {
  const request = vi.fn<OpenClawSettingsConnection["request"]>().mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ ok: true, restart: { scheduled: true }, config: { secret: "not-returned" } });
  const connection = { request };
  const settings = new OpenClawNativeSettings(() => connection);
  const form = await settings.read();
  expect(form.fields.find(field => field.key === "model")).toMatchObject({ value: "fixture/one", editable: true });
  expect(form.fields.find(field => field.key === "workspace")).toMatchObject({ value: "/fixtures/workspace" });
  expect(JSON.stringify(form)).not.toMatch(/native-secret|fixture-r1|gateway\.auth|agents\.defaults/);
  const receipt = await settings.apply(form.ticket, { fallbacks: ["fixture/two"], deny: [], elevated: false, thinking: "low", execMode: null });
  expect(receipt).toEqual({ state: "saved", restarting: true });
  expect(request).toHaveBeenNthCalledWith(1, "config.get", {});
  const [method, params] = request.mock.calls[1]! as [string, { baseHash: string; raw: string; response: string; replacePaths: string[] }];
  expect(method).toBe("config.patch");
  expect({ ...params, raw: JSON.parse(params.raw) }).toEqual({ baseHash: "fixture-r1", response: "summary", replacePaths: ["tools.deny"], raw: {
    agents: { defaults: { model: { primary: "fixture/one", fallbacks: ["fixture/two"] } } },
    tools: { deny: [], elevated: { enabled: false }, exec: { mode: null } },
  } });
  await expect(settings.apply(form.ticket, { workspace: "/other" })).rejects.toThrow(/过期/);
  expect(request).toHaveBeenCalledTimes(2);
});

// Refuse arbitrary config and legacy values that cannot be represented safely; never send a speculative write.
test("rejects unsupported leaves, malformed values, and incompatible tool policy", async () => {
  const request = vi.fn<OpenClawSettingsConnection["request"]>().mockResolvedValue({ ...snapshot, sourceConfig: {
    agents: { defaults: { model: { primary: "fixture/one" } } }, tools: { allow: ["exec"], exec: { ask: "on-miss" } },
  } });
  const connection = { request };
  const settings = new OpenClawNativeSettings(() => connection);
  const form = await settings.read();
  expect(form.fields.find(field => field.key === "execMode")?.editable).toBe(false);
  await expect(settings.apply(form.ticket, { execMode: "ask" })).rejects.toThrow(/不能在 Host 编辑/);
  await expect(settings.apply(form.ticket, { "gateway.auth.token": "do-not-send" })).rejects.toThrow(/不能在 Host 编辑/);
  await expect(settings.apply(form.ticket, JSON.parse('{"__proto__":{"bad":true}}'))).rejects.toThrow(/不能在 Host 编辑/);
  await expect(settings.apply(form.ticket, { workspace: "not/absolute" })).rejects.toThrow(/默认工作区/);
  await expect(settings.apply(form.ticket, { resetHour: 24 })).rejects.toThrow(/重置时刻/);
  await expect(settings.apply(form.ticket, { alsoAllow: ["read"] })).rejects.toThrow(/不能同时设置/);
  await expect(settings.apply(form.ticket, { allow: ["exec"] })).resolves.toEqual({ state: "unchanged" });
  expect(request).toHaveBeenCalledTimes(1);
});

// A valid prior form cannot be replayed after reconnect, privilege withdrawal, or concurrent native writes.
test("requires a fresh connection and revision after a drop or change", async () => {
  const request = vi.fn<OpenClawSettingsConnection["request"]>().mockResolvedValue(snapshot);
  let connection: OpenClawSettingsConnection | undefined = { request };
  const settings = new OpenClawNativeSettings(() => connection);
  const old = await settings.read();
  connection = undefined;
  await expect(settings.apply(old.ticket, { timeout: 60 })).rejects.toThrow(/过期/);
  await expect(settings.read()).rejects.toThrow(/管理员权限/);
  connection = { request };
  const { ticket } = await settings.read();
  request.mockRejectedValueOnce(new GatewayClientRequestError({ code: "INVALID_REQUEST", message: "config changed since last load; re-run config.get and retry" }));
  await expect(settings.apply(ticket, { timeout: 60 })).rejects.toThrow(/已被修改/);
  await expect(settings.apply(ticket, { timeout: 60 })).rejects.toThrow(/过期/);
  const next = await settings.read();
  request.mockRejectedValueOnce(new Error("private socket diagnostic"));
  await expect(settings.apply(next.ticket, { timeout: 60 })).rejects.toThrow(/未确认配置是否保存/);
  expect(request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(2);
});
