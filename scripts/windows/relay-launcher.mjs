import { closeSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const [root, entryPoint, stdoutPath, stderrPath] = process.argv.slice(2);
if (!root || !entryPoint || !stdoutPath || !stderrPath) {
  console.error("Usage: relay-launcher.mjs <root> <entryPoint> <stdout> <stderr>");
  process.exit(2);
}

const stdout = openSync(resolve(stdoutPath), "a");
const stderr = openSync(resolve(stderrPath), "a");
const child = spawn(process.execPath, [resolve(root, entryPoint)], {
  cwd: resolve(root),
  env: process.env,
  detached: true,
  stdio: ["ignore", stdout, stderr],
  windowsHide: true,
});
child.unref();
closeSync(stdout);
closeSync(stderr);
process.stdout.write(String(child.pid));
