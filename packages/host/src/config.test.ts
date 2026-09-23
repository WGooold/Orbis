import { describe, expect, it } from "vitest";
import { defaultStunServers } from "./config.js";

describe("STUN routing", () => {
  it("bypasses the HTTPS proxy only for the official Relay hostname", () => {
    expect(defaultStunServers("wss://orbising.com/relay")).toEqual(["stun://74.81.55.191:3478"]);
    expect(defaultStunServers("wss://relay.example.com/relay")).toEqual(["stun://relay.example.com:3478"]);
    expect(defaultStunServers("wss://orbising.com.example.com")).toEqual(["stun://orbising.com.example.com:3478"]);
    expect(defaultStunServers("ws://localhost:8787")).toEqual([]);
    expect(defaultStunServers(undefined)).toEqual([]);
  });
});
