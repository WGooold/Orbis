import { runOpenCodeTerminalHandoff } from "./opencode-local-launch.js";

try { process.exitCode = await runOpenCodeTerminalHandoff(process.argv[2]); }
catch (error) {
  console.error(error instanceof Error ? error.message : "无法恢复 OpenCode 会话，请从 Host 重试");
  process.exitCode = 1;
}
