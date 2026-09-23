import { cp } from "node:fs/promises";
await cp(new URL("../packages/relay/src/web/", import.meta.url), new URL("../packages/relay/dist/web/", import.meta.url), { recursive: true });
