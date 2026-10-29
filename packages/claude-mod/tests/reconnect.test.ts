import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

function setup(on: On) {
  const clock = mock.clock(on);
  mock.env(on, { ORBIS_STATE_DIR: "/orbis-test" });
  const world = {
    descriptor: { url: "ws://127.0.0.1:41001", token: "first-host-token-for-test" },
    descriptorPresent: true,
    reachable: true,
    generation: "first-generation",
    rejection: "",
    pollError: "",
    commands: [] as { commandId: string; command: { type: "user_message"; text: string } }[],
    submits: 0,
    requests: [] as { url: string; authorization: string | undefined; body: Record<string, unknown> }[],
    statuses: [] as (string | undefined)[],
  };
  on("session.start", (_$, event) => ({ cwd: event.cwd }));
  on("session.id", () => ({ value: "same-native-session" }));
  on("session.version", () => ({ value: { version: "2.1.312", base: "2.1.312", builtAt: "2026-10-29" } }));
  on("session.cwd", () => ({ value: "/workspace" }));
  on("session.model", () => ({ value: "test-model" }));
  on("session.usage", () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }));
  on("command.register", (_$, event) => ({ value: { command: event.name } }));
  on("command.list", () => ({ value: [] }));
  on("config.list", () => ({ value: [] }));
  on("settings.read", () => ({ value: {} }));
  on("prompt.submit", async () => {
    world.submits++;
    await clock.sleep(3000);
    return { drop: "Test: no model is called" };
  });
  on("ui.status", (_$, event) => { world.statuses.push(event.text); return { value: undefined }; });
  on("fs.read", (_$, event) => {
    expect(event.path).toBe("/orbis-test/loopback.json");
    return world.descriptorPresent ? { value: JSON.stringify(world.descriptor) } : { deny: "Host discovery is absent" };
  });
  on("http.fetch", (_$, event) => {
    const body = JSON.parse(event.init?.body ?? "{}") as Record<string, unknown>;
    world.requests.push({ url: event.url, authorization: event.init?.headers?.authorization, body });
    if (!world.reachable) return { deny: "Connection refused" };
    expect(event.url.startsWith(world.descriptor.url.replace(/^ws:/u, "http:"))).toBe(true);
    expect(event.init?.headers?.authorization).toBe(`Bearer ${world.descriptor.token}`);
    const reply = (status: number, value: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(value) } });
    if (event.url.endsWith("/hello")) return world.rejection
      ? reply(409, { ok: false, error: world.rejection })
      : reply(200, { ok: true, runtimeId: "claude:same-native-session", generation: world.generation });
    if (event.url.endsWith("/poll")) return world.pollError
      ? reply(world.pollError === "unauthorized" ? 401 : 409, { ok: false, error: world.pollError })
      : reply(200, { ok: true, commands: world.commands });
    return reply(202, { result: "accepted" });
  });
  return { clock, world, hellos: () => world.requests.filter(request => request.url.endsWith("/hello")) };
}

test("rediscovers a restarted Host without restarting the native Claude session", async ($, on) => {
  const { clock, world, hellos } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  expect(hellos()).toHaveLength(1);

  world.reachable = false;
  await clock.advance(1500);
  world.descriptorPresent = false;
  await clock.advance(750);
  expect(hellos()).toHaveLength(1);

  world.descriptor = { url: "ws://127.0.0.1:42002", token: "second-host-token-for-test" };
  world.descriptorPresent = true;
  world.reachable = true;
  world.generation = "second-generation";
  await clock.advance(750);
  expect(hellos()).toHaveLength(2);
  expect(hellos()[1]?.body.sessionId).toBe(hellos()[0]?.body.sessionId);
  expect(hellos()[1]?.body.instanceId).toBe(hellos()[0]?.body.instanceId);
  expect(world.requests).toContainEqual(expect.objectContaining({
    url: "http://127.0.0.1:42002/v1/claude/mods/poll",
    authorization: "Bearer second-host-token-for-test",
    body: { runtimeId: "claude:same-native-session", generation: "second-generation" },
  }));
  expect(world.requests.some(request => request.url.endsWith("/event") && request.body.generation === "second-generation"
    && (request.body.event as { type?: string }).type === "session.state")).toBe(true);
  expect(world.statuses.at(-1)).toBeUndefined();
});

test("preserves the generation across a temporary HTTP failure on the same Host", async ($, on) => {
  const { clock, world, hellos } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  world.reachable = false;
  await clock.advance(750);
  world.reachable = true;
  await clock.advance(750);
  expect(hellos()).toHaveLength(1);
  expect(world.requests.at(-1)?.body.generation).toBe("first-generation");
  expect(world.statuses.at(-1)).toBeUndefined();
});

test("scopes a refused hello's backoff to that Host endpoint and token", async ($, on) => {
  const { clock, world, hellos } = setup(on);
  world.rejection = "missing_capability:test";
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await clock.advance(1500);
  expect(hellos()).toHaveLength(1);
  world.descriptor.token = "new-host-token-at-same-port";
  world.generation = "second-generation";
  world.rejection = "";
  await clock.advance(750);
  expect(hellos()).toHaveLength(2);
  expect(hellos()[1]?.authorization).toBe("Bearer new-host-token-at-same-port");
});

test("does not replay an in-flight prompt or send its old result to the restarted Host", async ($, on) => {
  const { clock, world, hellos } = setup(on);
  world.commands = [{ commandId: "old-command", command: { type: "user_message", text: "mock prompt" } }];
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  expect(world.submits).toBe(1);
  await clock.advance(750);
  expect(world.submits).toBe(1);
  world.commands = [];
  world.descriptor = { url: "ws://127.0.0.1:42002", token: "second-host-token-for-test" };
  world.generation = "second-generation";
  await clock.advance(3750);
  expect(hellos()).toHaveLength(2);
  expect(world.submits).toBe(1);
  expect(world.requests.some(request => request.url.endsWith("/event")
    && (request.body.event as { commandId?: string }).commandId === "old-command")).toBe(false);
});

for (const error of ["unauthorized", "stale_generation", "bridge_offline"]) {
  test(`refreshes the connection generation after ${error}`, async ($, on) => {
    const { clock, world, hellos } = setup(on);
    await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
    await clock.settle();
    world.pollError = error;
    await clock.advance(750);
    world.pollError = "";
    world.generation = "renewed-generation";
    await clock.advance(750);
    expect(hellos()).toHaveLength(2);
    expect(world.requests.at(-1)?.body.generation).toBe("renewed-generation");
  });
}
