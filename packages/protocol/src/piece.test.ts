import { describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION, V2FrameSchema, type EnvelopeV2 } from "./index.js";
import {
  EnvelopeReassembler,
  PIECE_MAX_CT_CHARS,
  fragmentEnvelope,
  isPieceEnvelope,
  type ReassemblyRejection,
} from "./piece.js";

/**
 * 这一组用例锁的是 issue 03 的片层不变量：**重组必须逐字节还原**、**小消息不切**、
 * **有界且会超时**。至于"水位因此重新有效"这件事，由 Host 侧的延迟验收项回答（见 issue 03
 * 的「验收」），不在这里假装。
 */
const envelope = (ctChars: number, overrides: Partial<EnvelopeV2["hdr"]> = {}): EnvelopeV2 => ({
  v: 2,
  hdr: { k: "bin", room: "r1", from: "d1", to: "h1", n: 7, ch: "bulk", ...overrides },
  // `ct` 在真实帧里是 base64url（纯 ASCII、不含引号），这里用同字符集的填充物保持一致。
  ct: "A".repeat(ctChars),
});

describe("写入层切片", () => {
  it("大信封切成片后能逐字节还原，小信封原样发", () => {
    const big = envelope(PIECE_MAX_CT_CHARS * 3 + 17);
    const pieces = fragmentEnvelope(big, { mid: "m1" });

    expect(pieces).toHaveLength(4);
    expect(pieces.every(isPieceEnvelope)).toBe(true);
    expect(pieces.at(-1)?.hdr.last).toBe(true);
    // 片头带路由与 channel，中继才不用重组：它只看 hdr。
    expect(pieces[0]?.hdr).toMatchObject({ to: "h1", ch: "bulk", ik: "bin", n: 7, mid: "m1", idx: 0, last: false });
    // 每一片自己都得是合法线上帧（中继/对端都按 v2.frame 校验）。
    for (const piece of pieces) {
      expect(V2FrameSchema.safeParse({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope: piece }).success).toBe(true);
    }

    const reassembler = new EnvelopeReassembler();
    const rebuilt: EnvelopeV2[] = [];
    for (const piece of pieces) {
      const done = reassembler.accept(piece);
      if (done !== undefined) rebuilt.push(done);
    }
    expect(rebuilt).toEqual([big]);
    expect(reassembler.bufferedChars).toBe(0);

    // 小消息不切：否则每条控制帧都要多背一个片头。
    const small = envelope(PIECE_MAX_CT_CHARS);
    expect(fragmentEnvelope(small, { mid: "m2" })).toEqual([small]);
    expect(new EnvelopeReassembler().accept(small)).toEqual(small);
    // 握手帧不参与加密流，永远不切。
    const hs = envelope(0, { k: "hs", ch: undefined });
    expect(fragmentEnvelope(hs)).toEqual([hs]);
  });

  it("乱序能重组；重传同内容的片幂等；同一个 mid 带不同身份则整条丢弃", () => {
    const big = envelope(PIECE_MAX_CT_CHARS * 2 + 5);
    const [first, second, third] = fragmentEnvelope(big, { mid: "m1" });
    const rejected: ReassemblyRejection[] = [];
    const reassembler = new EnvelopeReassembler({ onRejected: (reason) => rejected.push(reason) });

    // 换路径会让片乱序到达：按 idx 存，末片到了且 0..total-1 齐全就交付。
    expect(reassembler.accept(third!)).toBeUndefined();
    expect(reassembler.accept(first!)).toBeUndefined();
    // 发送侧重试过被拒的那一片 → 同一片可能来两次，同内容当无事发生。
    expect(reassembler.accept(first!)).toBeUndefined();
    expect(reassembler.accept(second!)).toEqual(big);
    expect(rejected).toEqual([]);

    // 同一个 mid 的第二片带着别的序号身份：不是同一条消息。
    const reassembler2 = new EnvelopeReassembler({ onRejected: (reason) => rejected.push(reason) });
    reassembler2.accept(first!);
    reassembler2.accept({ ...second!, hdr: { ...second!.hdr, n: 99 } });
    expect(reassembler2.bufferedChars).toBe(0);
    expect(rejected).toEqual(["conflict"]);
  });

  it("重组缓冲有界：超并发条数或超总字节都丢掉并在回调里可见", () => {
    const rejected: ReassemblyRejection[] = [];
    const reassembler = new EnvelopeReassembler({ maxMessages: 2, onRejected: (reason) => rejected.push(reason) });
    const pieceOf = (mid: string, chars = 100, idx = 0): EnvelopeV2 => ({
      v: 2,
      hdr: { k: "piece", room: "r1", from: "d1", to: "h1", n: 7, ch: "bulk", ik: "bin", mid, idx, last: false },
      ct: "A".repeat(chars),
    });

    reassembler.accept(pieceOf("a"));
    reassembler.accept(pieceOf("b"));
    // 第 3 条超并发上限：丢掉最旧的一条，新的一条仍然进得来（否则一次攻击就能永久占住槽位）。
    reassembler.accept(pieceOf("c"));
    expect(reassembler.pendingMessages).toBe(2);
    expect(rejected).toContain("budget");

    // 单条消息自己超过总字节上限：立刻丢，不占着内存等末片。
    const tight = new EnvelopeReassembler({ maxCtChars: 150, onRejected: (reason) => rejected.push(reason) });
    tight.accept(pieceOf("d"));
    tight.accept(pieceOf("d", 100, 1));
    expect(tight.bufferedChars).toBe(0);
    expect(rejected.filter((r) => r === "budget").length).toBeGreaterThanOrEqual(2);
  });

  it("缺片不猜：等超时丢掉半截消息，绝不交付半条", () => {
    const big = envelope(PIECE_MAX_CT_CHARS * 2 + 5);
    const [first, second, third] = fragmentEnvelope(big, { mid: "m1" });
    const rejected: ReassemblyRejection[] = [];
    let now = 1_000;
    const reassembler = new EnvelopeReassembler({
      timeoutMs: 5_000,
      now: () => now,
      onRejected: (reason) => rejected.push(reason),
    });

    expect(reassembler.accept(first!)).toBeUndefined();
    expect(reassembler.accept(third!)).toBeUndefined();
    now += 6_000;
    reassembler.sweep();
    expect(reassembler.bufferedChars).toBe(0);
    expect(rejected).toEqual(["timeout"]);
    // 迟到的缺片不会让一条已经作废的消息复活：它只是另一条新消息的第一片。
    expect(reassembler.accept(second!)).toBeUndefined();
    expect(reassembler.bufferedChars).toBe(PIECE_MAX_CT_CHARS);
  });

  it("片帧不能再被切片", () => {
    const [piece] = fragmentEnvelope(envelope(PIECE_MAX_CT_CHARS * 2), { mid: "m1" });
    expect(() => fragmentEnvelope(piece!)).toThrowError(/片帧不能再被切片/);
    expect(vi.fn()).not.toHaveBeenCalled();
  });
});
