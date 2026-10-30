import { describe, expect, it } from "vitest";
import { FileChangeMetadataSchema, FileChangeDetailReadRequestSchema, FileChangeDetailPageSchema, TurnChangesListRequestSchema } from "./turn-file-changes.js";

const agent = { hostId: "h", agentKind: "pi", sessionId: "s" };
const metadata = { fileId: "opaque", path: "src/example.ts", changeKind: "modified", fileKind: "text", additions: 2, deletions: 1,
  beforeBytes: 10, afterBytes: 20, contentVersion: "frozen-version", detail: "available" };
describe("turn change metadata and private reads", () => {
  it("rejects content smuggled into metadata", () => {
    expect(FileChangeMetadataSchema.safeParse(metadata).success).toBe(true);
    for (const property of ["content", "patch", "before", "after", "preview", "snapshotPath"]) {
      expect(FileChangeMetadataSchema.safeParse({ ...metadata, [property]: "source" }).success).toBe(false);
    }
  });
  it("bounds list windows and requires immutable identities instead of filesystem paths", () => {
    expect(TurnChangesListRequestSchema.safeParse({ type: "session.changes.list", requestId: "r", runtimeId: "rt", agent,
      entryIds: Array.from({ length: 257 }, (_, i) => `${i}`), turnIds: [] }).success).toBe(false);
    const request = { type: "session.change.detail.read", requestId: "r", runtimeId: "rt", agent,
      changeSetId: "set", manifestVersion: 1, fileId: "file", contentVersion: "version", viewerId: "viewer", readId: null, cursor: null, maxBytes: 49152 };
    expect(FileChangeDetailReadRequestSchema.safeParse(request).success).toBe(true);
    expect(FileChangeDetailReadRequestSchema.safeParse({ ...request, path: "/etc/hosts" }).success).toBe(false);
    expect(FileChangeDetailReadRequestSchema.safeParse({ ...request, maxBytes: 49153 }).success).toBe(false);
  });
  it("measures complete serialized JSON, including escaping and Unicode", () => {
    const page = { type: "session.change.detail.page", requestId: "r", runtimeId: "rt", agent,
      changeSetId: "set", manifestVersion: 1, fileId: "file", contentVersion: "version", viewerId: "viewer", readId: "read", nextCursor: null, eof: true };
    expect(FileChangeDetailPageSchema.safeParse({ ...page, text: "x".repeat(48 * 1024) }).success).toBe(true);
    expect(FileChangeDetailPageSchema.safeParse({ ...page, text: "\t".repeat(48 * 1024) }).success).toBe(false);
  });
});
