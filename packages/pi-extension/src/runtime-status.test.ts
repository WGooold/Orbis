import { describe, expect, it } from "vitest";

import { statusToReconcile } from "./runtime-status.js";

describe("runtime status reconcile", () => {
  // 这条不是实现细节：`waiting`（等待电脑端本地交互）推不出来，只能由 prompt 事件给。
  // 节拍若照 isIdle 覆盖它，手机上「等待电脑端交互」会每 15 秒闪回一次 idle。
  it("keeps a local-interaction status out of the reconcile cadence", () => {
    expect(statusToReconcile("waiting", true)).toBeUndefined();
    expect(statusToReconcile("waiting", false)).toBeUndefined();
    expect(statusToReconcile("idle", false)).toBe("running");
    expect(statusToReconcile("running", true)).toBe("idle");
  });
});
