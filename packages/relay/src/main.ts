import { createRelayServer } from "./index.js";
import { RegistrationAuthority } from "./registration.js";
import { verificationMailer } from "./verification-mail.js";
import { orbisEnvironment } from "@orbis/protocol";
import { readFile } from "node:fs/promises";

const port = Number(process.env.PORT ?? 8787);
const runtimeCredential = orbisEnvironment(process.env, "RUNTIME_CREDENTIAL");
const adminToken = orbisEnvironment(process.env, "ADMIN_TOKEN");
const stateFile = orbisEnvironment(process.env, "STATE_FILE") ?? process.env.ORBIS_DEFAULT_STATE_FILE ?? "./data/relay-state.json";
const sendMail = verificationMailer();
const apnsKeyPath = orbisEnvironment(process.env, "APNS_PRIVATE_KEY_FILE");
const apns = apnsKeyPath ? {
  keyId: orbisEnvironment(process.env, "APNS_KEY_ID") ?? "",
  teamId: orbisEnvironment(process.env, "APNS_TEAM_ID") ?? "",
  bundleId: orbisEnvironment(process.env, "APNS_BUNDLE_ID") ?? "",
  privateKey: await readFile(apnsKeyPath, "utf8"),
  environment: (orbisEnvironment(process.env, "APNS_ENVIRONMENT") ?? "production") as "sandbox" | "production",
} : undefined;
const registration = await RegistrationAuthority.create({
  stateFile: process.env.ORBIS_REGISTRATION_STATE_FILE ?? `${stateFile}.registration.json`,
  ...(sendMail === undefined ? {} : { sendMail }),
});

const relay = await createRelayServer({
  ...(process.env.ORBIS_QUIC_PORT === undefined ? {} : { quicPort: Number(process.env.ORBIS_QUIC_PORT) }),
  quicHistoryStreamsEnabled: process.env["ORBIS_RELAY_QUIC_HISTORY_STREAMS"] === "1",
  quicHostEnabled: process.env.ORBIS_QUIC_HOST_ENABLED === "1",
  ...(process.env.ORBIS_RELAY_BULK_BYTES_PER_SECOND === undefined ? {} : { bulkBytesPerSecond: Number(process.env.ORBIS_RELAY_BULK_BYTES_PER_SECOND) }),
  port,
  host: process.env.HOST ?? "0.0.0.0",
  runtimeCredentials: runtimeCredential ? [runtimeCredential] : [],
  ...(adminToken === undefined ? {} : { adminToken }),
  registration,
  trustProxy: process.env.ORBIS_TRUST_PROXY === "1",
  adminStateFile: process.env.ORBIS_ADMIN_STATE_FILE ?? `${stateFile}.admin.json`,
  bandwidthStateFile: process.env.ORBIS_BANDWIDTH_STATE_FILE ?? `${stateFile}.bandwidth.json`,
  ...(process.env.ORBIS_DOWNLOADS_DIR ? { downloadsDir: process.env.ORBIS_DOWNLOADS_DIR } : {}),
  // nginx 把 /var/www/orbis-downloads 挂在 /downloads/ 下；Android 的版本元数据写在那里，
  // 与 CI 归档的 Windows 下载不是同一个目录。
  ...(process.env.ORBIS_ANDROID_DOWNLOADS_DIR ? { androidDownloadsDir: process.env.ORBIS_ANDROID_DOWNLOADS_DIR } : {}),
  ...(process.env.ORBIS_RELEASE_COMMIT ? { buildCommit: process.env.ORBIS_RELEASE_COMMIT } : {}),
  stateFile,
});
console.log(`Orbis Relay listening at ${relay.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void relay.close().then(() => process.exit(0)));
}
