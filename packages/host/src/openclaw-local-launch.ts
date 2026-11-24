import { createConnection } from "node:net";
import { checkServiceCliVersion, launchLocalService, serviceCli, waitForLocalAgent, type LocalAgentChild, type StartGuard } from "./local-agent-start.js";

const OPENCLAW_LAUNCH_VERSION = "2026.11.5";

/** Only the Host's explicit IPv4 local port is launchable. TLS/proxy/remote addresses stay attach-only. */
export function localOpenClawPort(value: string): number | undefined {
  const url = URL.parse(value);
  if (!url || url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port) <= 0 || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
  return Number(url.port);
}

function listening(port: number, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port, signal });
    socket.setTimeout(750, () => { socket.destroy(); reject(new Error("无法确认 OpenClaw 本机端口状态")); });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(new Error("无法确认 OpenClaw 本机端口状态"));
    });
  });
}

type Attachment = { ready: () => boolean; pairingEpoch: () => number; retry: () => Promise<void> };
export type OpenClawLocalLauncher = {
  available(url: string): Promise<boolean>;
  start(url: string, guard: StartGuard, backend: Attachment): Promise<void>;
};

export function createOpenClawLocalLauncher(env: NodeJS.ProcessEnv = process.env): OpenClawLocalLauncher {
  const cli = serviceCli("openclaw", env);
  const find = () => cli.find(OPENCLAW_LAUNCH_VERSION);
  return {
    available: async url => localOpenClawPort(url) !== undefined && await find() !== undefined,
    start: async (url, guard, backend) => {
      const port = localOpenClawPort(url);
      if (port === undefined) throw new Error("远程或 TLS OpenClaw Gateway 只接入已有服务");
      const { signal, check } = guard;
      const awaitGateway = async (child?: LocalAgentChild) => {
        await waitForLocalAgent(signal, async () => {
          if (await listening(port, signal)) return true;
          if (child?.exited()) throw new Error("OpenClaw Gateway 启动失败，请检查电脑端配置");
          return undefined;
        });
        const prior = backend.pairingEpoch();
        check();
        if (!backend.ready()) await backend.retry();
        return waitForLocalAgent(signal, () => {
          if (backend.ready()) return "ready" as const;
          if (backend.pairingEpoch() > prior) return "needs_approval" as const;
          if (child?.exited()) throw new Error("OpenClaw Gateway 启动失败，请检查电脑端配置");
          return undefined;
        });
      };
      let approval = false;
      if (backend.ready()) return;
      if (await listening(port, signal)) {
        approval = await awaitGateway() === "needs_approval";
      } else {
        const entry = await find();
        if (!entry) throw new Error(`未找到兼容的 OpenClaw ${OPENCLAW_LAUNCH_VERSION} CLI`);
        const command = await cli.resolve(entry);
        await checkServiceCliVersion(command, cli.cwd, cli.env, signal, "OpenClaw", OPENCLAW_LAUNCH_VERSION);
        check();
        // Do not replace an existing listener or override the user's Gateway credentials or mode.
        if (!backend.ready() && !await listening(port, signal)) {
          check();
          await launchLocalService(command, ["gateway", "run", "--bind", "loopback", "--port", String(port), "--tailscale", "off"], cli, async child => {
            approval = await awaitGateway(child) === "needs_approval";
            return !child.exited();
          });
        } else if (!backend.ready()) approval = await awaitGateway() === "needs_approval";
      }
      if (approval) throw new Error("OpenClaw Gateway 已启动，等待在 OpenClaw 中批准 Orbis Host");
    },
  };
}
