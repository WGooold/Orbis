import { createRelayServer } from "./index.js";
import { RegistrationAuthority } from "./registration.js";
import { verificationMailer } from "./verification-mail.js";

const port = Number(process.env.PORT ?? 8787);
const runtimeCredential = process.env.PI_REMOTE_RUNTIME_CREDENTIAL;
const adminToken = process.env.PI_REMOTE_ADMIN_TOKEN;
const sendMail = verificationMailer();
const registration = await RegistrationAuthority.create({
  stateFile: process.env.ORBIS_REGISTRATION_STATE_FILE ?? `${process.env.PI_REMOTE_STATE_FILE ?? "./data/relay-state.json"}.registration.json`,
  ...(sendMail === undefined ? {} : { sendMail }),
});

const relay = await createRelayServer({
  port,
  host: process.env.HOST ?? "0.0.0.0",
  runtimeCredentials: runtimeCredential ? [runtimeCredential] : [],
  ...(adminToken === undefined ? {} : { adminToken }),
  registration,
  trustProxy: process.env.ORBIS_TRUST_PROXY === "1",
  adminStateFile: process.env.ORBIS_ADMIN_STATE_FILE ?? `${process.env.PI_REMOTE_STATE_FILE ?? "./data/relay-state.json"}.admin.json`,
  ...(process.env.ORBIS_DOWNLOADS_DIR ? { downloadsDir: process.env.ORBIS_DOWNLOADS_DIR } : {}),
  ...(process.env.ORBIS_RELEASE_COMMIT ? { buildCommit: process.env.ORBIS_RELEASE_COMMIT } : {}),
  stateFile: process.env.PI_REMOTE_STATE_FILE ?? "./data/relay-state.json",
});
console.log(`Orbis Relay listening at ${relay.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void relay.close().then(() => process.exit(0)));
}
