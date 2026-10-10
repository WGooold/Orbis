import { readFile } from "node:fs/promises";
import process from "node:process";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: npm run load:report -- report-a.json report-b.json");
  process.exit(2);
}
for (const file of files) {
  const report = JSON.parse(await readFile(file, "utf8"));
  const { config, counters, latency } = report;
  console.log(JSON.stringify({
    file,
    scenario: config.scenario,
    hosts: config.hostCount,
    devices: config.hostCount * config.devicesPerHost,
    durationSeconds: config.durationSeconds,
    connected: counters.connected,
    connectErrors: counters.connectErrors,
    framesSent: counters.framesSent,
    framesReceived: counters.framesReceived,
    protocolErrors: counters.protocolErrors,
    p50Ms: latency.p50Ms,
    p95Ms: latency.p95Ms,
    p99Ms: latency.p99Ms,
  }));
}
