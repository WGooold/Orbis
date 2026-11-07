// FT-G07: one cross-platform wire fixture proves exact single-body restoration,
// UTF-8 streaming append, source isolation and unchanged legacy authority.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { applyStateDelta, RelayToDeviceMessageSchema } from "@orbis/protocol";
import { SessionWireContent } from "./session-wire-content.js";

const fixture = JSON.parse(readFileSync(new URL("../../../ios/Orbis/Tests/Fixtures/field-transport-session.json", import.meta.url), "utf8"));
describe("FT-G07 session wire content", () => {
  it("matches the mobile contract and emits only the new live text", () => {
    const wire = new SessionWireContent();
    expect(wire.project(fixture.initial)).toEqual(fixture.wireInitial);
    expect(wire.project(fixture.patch)).toEqual(fixture.wirePatch);
    expect(RelayToDeviceMessageSchema.safeParse(fixture.wireInitial).success).toBe(true);
    expect(RelayToDeviceMessageSchema.safeParse(fixture.wirePatch).success).toBe(true);
    expect(applyStateDelta(fixture.initial.event.live, fixture.wirePatch.sharedContent.liveDelta.operations)).toEqual(fixture.patch.event.live);
    expect(Buffer.byteLength(JSON.stringify(fixture.wireInitial))).toBeLessThan(Buffer.byteLength(JSON.stringify(fixture.initial)) * 0.65);
    expect(Buffer.byteLength(JSON.stringify(fixture.wirePatch))).toBeLessThan(Buffer.byteLength(JSON.stringify(fixture.patch)) / 2);
    expect(fixture.initial.event.live.messages[0].message.content[0].text).not.toBe("");
    // All recipients of the same source event see the same patch, not a base
    // accidentally advanced by encoding the first recipient's envelope.
    expect(wire.project({ ...fixture.patch, sequence: 99 })).toMatchObject({ sharedContent: fixture.wirePatch.sharedContent });
  });
  it("sends a full live state without the exact epoch/session/base and after cache eviction", () => {
    for (const change of ["epoch", "sessionId", "baseSeq"]) {
      const wire = new SessionWireContent(); wire.project(fixture.initial);
      const event = structuredClone(fixture.patch);
      if (change === "epoch") event.event.source.epoch = "replacement";
      else event.event[change] = change === "baseSeq" ? 10 : "other";
      expect(wire.project(event)).not.toHaveProperty("sharedContent.liveDelta");
    }
    const wire = new SessionWireContent(); wire.project(fixture.initial); wire.clear();
    expect(wire.project(structuredClone(fixture.patch))).not.toHaveProperty("sharedContent.liveDelta");
  });
});
