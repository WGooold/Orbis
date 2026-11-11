import type { On } from "claude-code";
import { expect, mock } from "claude-code/testing";

/** The engine resolves mod file paths onto the current drive on Windows ("/x" becomes "D:/x"). */
function sameFile(actual: string, expected: string): boolean {
  const slashed = (path: string): string => path.replaceAll("\\", "/").replace(/^[A-Za-z]:/u, "");
  return slashed(actual) === slashed(expected);
}

/** Shared isolated Host discovery, clock and HTTP boundary; model submissions stay mocked. */
export function setup(on: On, options: { home?: string } = {}) {
  const clock = mock.clock(on);
  const home = options.home;
  // A Host-launched Claude Code receives ORBIS_STATE_DIR; a hand-started session resolves the
  // state directory from the user profile, where an upgraded Host may still use the legacy name.
  mock.env(on, home === undefined ? { ORBIS_STATE_DIR: "/orbis-test" } : { USERPROFILE: home });
  const roots = home === undefined ? ["/orbis-test"]
    : [`${home}${home.includes("\\") ? "\\" : "/"}.orbis`, `${home}${home.includes("\\") ? "\\" : "/"}.pi-remote`];
  const discoveryPaths = roots.map(root => `${root.replace(/[\\/]+$/u, "")}${root.includes("\\") ? "\\" : "/"}loopback.json`);
  const discovery = discoveryPaths.at(-1);
  const world = {
    descriptor: { url: "ws://127.0.0.1:41001", token: "first-host-token-for-test" },
    descriptorPresent: true,
    sessionId: "same-native-session",
    model: "test-model",
    reachable: true,
    generation: "first-generation",
    resumed: false,
    rejection: "",
    pollError: "",
    commands: [] as { commandId: string; command: { type: "user_message"; text: string } | { type: "stop" } | { type: "slash"; name: string; args: string } }[],
    submits: 0,
    toolResult: "still working",
    toolCalls: [] as unknown[],
    denyPrompt: true,
    completionDelay: 0,
    aborts: [] as string[],
    requests: [] as { url: string; authorization: string | undefined; body: Record<string, unknown> }[],
    statuses: [] as (string | undefined)[],
    agents: [] as { id: string; description: string; type: string; status: string; parentId?: string }[],
    agentListFails: false,
    agentListDelay: 0,
  };
  on("session.start", (_$, event) => ({ cwd: event.cwd }));
  on("agent.list", async () => {
    const agents = world.agents;
    if (world.agentListDelay) await clock.sleep(world.agentListDelay);
    return world.agentListFails ? { deny: "read failed" } : { value: agents as import("claude-code").AgentInfo[] };
  });
  on("session.id", () => ({ value: world.sessionId }));
  on("session.version", () => ({ value: { version: "2.1.312", base: "2.1.312", builtAt: "2026-10-29" } }));
  on("session.cwd", () => ({ value: "/workspace" }));
  on("process.run", (_$, event) => {
    expect(event.argv).toEqual(["node", "-e", "process.stdout.write(String(process.ppid))"]);
    return { value: { exitCode: 0, stdout: "4242", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on("session.model", () => ({ value: world.model }));
  on("session.usage", () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }));
  on("command.register", (_$, event) => ({ value: { command: event.name } }));
  on("command.list", () => ({ value: [] }));
  on("config.list", () => ({ value: [] }));
  on("settings.read", () => ({ value: {} }));
  on("turn.start", (_$, event) => ({ turnId: event.turnId }));
  on("turn.complete", (_$, event) => ({ text: event.answer }));
  on("turn.abort", (_$, event) => { world.aborts.push(event.turnId); return { value: undefined }; });
  on("tool.call", (_$, event) => { world.toolCalls.push(event); return { result: world.toolResult }; });
  on("prompt.submit", async () => {
    world.submits++;
    await clock.sleep(3000);
    return world.denyPrompt ? { drop: "Test: no model is called" } : { text: "accepted by test" };
  });
  on("ui.status", (_$, event) => { world.statuses.push(event.text); return { value: undefined }; });
  on("fs.read", (_$, event) => {
    const requested = discoveryPaths.find(path => sameFile(event.path, path));
    expect(requested).toBeDefined();
    return world.descriptorPresent && requested === discovery ? { value: JSON.stringify(world.descriptor) } : { deny: "Host discovery is absent" };
  });
  on("http.fetch", async (_$, event) => {
    const body = JSON.parse(event.init?.body ?? "{}") as Record<string, unknown>;
    world.requests.push({ url: event.url, authorization: event.init?.headers?.authorization, body });
    if (!world.reachable) return { deny: "Connection refused" };
    expect(event.url.startsWith(world.descriptor.url.replace(/^ws:/u, "http:"))).toBe(true);
    expect(event.init?.headers?.authorization).toBe(`Bearer ${world.descriptor.token}`);
    const reply = (status: number, value: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(value) } });
    if (event.url.endsWith("/hello")) return world.rejection
      ? reply(409, { ok: false, error: world.rejection })
      : reply(200, { ok: true, runtimeId: `claude:${body.sessionId}`, generation: world.generation, ...(world.resumed ? { resumed: true } : {}) });
    if (event.url.endsWith("/poll")) return world.pollError
      ? reply(world.pollError === "unauthorized" ? 401 : 409, { ok: false, error: world.pollError })
      : reply(200, { ok: true, commands: world.commands });
    if ((body.event as { type?: string } | undefined)?.type === "turn.complete" && world.completionDelay > 0) {
      await clock.sleep(world.completionDelay);
    }
    return reply(202, { result: "accepted" });
  });
  return { clock, world, hellos: () => world.requests.filter(request => request.url.endsWith("/hello")) };
}
