import { createConnection } from "node:net";
import { checkServiceCliVersion, launchLocalService, serviceCli, waitForLocalAgent, type StartGuard } from "./local-agent-start.js";
import { OpenClawSetupError, type OpenClawIssue } from "./openclaw-diagnostics.js";

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
    socket.setTimeout(750, () => { socket.destroy(); reject(new OpenClawSetupError("local_port_unknown")); });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(new OpenClawSetupError("local_port_unknown"));
    });
  });
}

type Attachment = {
  ready: () => boolean;
  issue: () => OpenClawIssue | undefined;
  retry: () => Promise<void>;
};

const keepOnDenial = new Set<OpenClawIssue>([
  "pairing_required", "pairing_rejected", "token_missing", "token_mismatch", "environment_token_missing",
  "environment_token_mismatch", "gateway_token_unconfigured", "device_token_rejected", "auth_rejected",
  "session_access_denied", "host_state_unavailable", "rate_limited",
]);

/** Retry once, leaving SDK reconnect policy and the outer Host deadline intact. */
export async function waitForOpenClawAttachment(guard: StartGuard, backend: Attachment, childExited = () => false): Promise<"ready" | OpenClawIssue> {
  guard.check();
  if (!backend.ready()) await backend.retry();
  return waitForLocalAgent(guard.signal, () => {
    guard.check();
    if (backend.ready()) return "ready";
    const issue = backend.issue();
    if (childExited() && (!issue || !keepOnDenial.has(issue))) throw new OpenClawSetupError("local_start_failed");
    // A transient transport failure or a Gateway that reports it is still starting
    // may recover before the deadline. Explicit denials can be passed back now.
    return issue === "starting" || issue === "connect_unconfirmed" || issue === "local_port_closed" ? undefined : issue;
  });
}
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
      if (port === undefined) throw new OpenClawSetupError("attach_only");
      const { signal, check } = guard;
      let outcome: "ready" | OpenClawIssue = "ready";
      if (backend.ready()) return;
      if (await listening(port, signal)) {
        outcome = await waitForOpenClawAttachment(guard, backend);
      } else {
        const entry = await find();
        check();
        if (!entry) {
          // The service could have come online during CLI discovery.
          if (backend.ready()) return;
          if (await listening(port, signal)) outcome = await waitForOpenClawAttachment(guard, backend);
          else throw new OpenClawSetupError("local_cli_unavailable");
        } else {
          const command = await (async () => {
            try {
              const resolved = await cli.resolve(entry);
              await checkServiceCliVersion(resolved, cli.cwd, cli.env, signal, "OpenClaw", OPENCLAW_LAUNCH_VERSION);
              return resolved;
            } catch { check(); throw new OpenClawSetupError("local_cli_incompatible"); }
          })();
          check();
          // Do not replace an existing listener or override the user's Gateway credentials or mode.
          if (!backend.ready() && !await listening(port, signal)) {
            check();
            await launchLocalService(command, ["gateway", "run", "--bind", "loopback", "--port", String(port), "--tailscale", "off"], cli, async child => {
              await waitForLocalAgent(signal, async () => {
                check();
                const bound = await listening(port, signal);
                if (bound) return true;
                if (child.exited()) throw new OpenClawSetupError("local_start_failed");
                return undefined;
              });
              outcome = await waitForOpenClawAttachment(guard, backend, child.exited);
              // A confirmed denial (e.g. missing token or pending approval) can be
              // fixed without killing an otherwise running Gateway. A missing
              // confirmation must still clean up an unpublished child.
              return !child.exited() && (outcome === "ready" || keepOnDenial.has(outcome));
            });
          } else if (!backend.ready()) outcome = await waitForOpenClawAttachment(guard, backend);
        }
      }
      check();
      if (outcome !== "ready") throw new OpenClawSetupError(outcome);
    },
  };
}
