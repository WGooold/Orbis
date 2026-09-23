/**
 * Pi 扩展的本机接入（spec §7.3）。
 *
 * 有常驻 Host 时走 loopback，没有时回落到 Relay：还没跑 `pi-remote host` 的用户
 * 体验必须和以前一模一样，所以「读不到发现文件」不是错误，只是一个分支。
 *
 * loopback 上不套 v2 Envelope——E2E 的边界是「手机 ↔ Host」，本机之后是同一个信任域。
 * 这正是 Host 的 loopback 端点可以复用 runtime 侧那套消息的原因。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  LOOPBACK_DESCRIPTOR_FILE,
  LOOPBACK_PATH,
  LoopbackDescriptorSchema,
  type LoopbackDescriptor,
} from "@pi-remote/protocol";

import { RelayRuntimeTransport, type RelayRuntimeConnectionState, type RelayRuntimeTransportOptions } from "./transport.js";

export function defaultLoopbackDescriptorPath(): string {
  return join(homedir(), ".pi-remote", LOOPBACK_DESCRIPTOR_FILE);
}

/**
 * 读 Host 写的发现文件。
 *
 * 文件缺失、坏 JSON、版本不认识，一律当作「本机没有 Host」返回 `undefined`——
 * 这是一个探测，不是一次断言，任何异常都不该让扩展起不来。
 */
export async function readLoopbackDescriptor(
  path: string = defaultLoopbackDescriptorPath(),
): Promise<LoopbackDescriptor | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown;
  } catch {
    return undefined;
  }
  const result = LoopbackDescriptorSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export type LoopbackHostTransportOptions =
  Omit<RelayRuntimeTransportOptions, "relayUrl" | "credential" | "resolveEndpoint">
  & {
    descriptor: LoopbackDescriptor;
    /** 发现文件路径（缺省 `~/.pi-remote/loopback.json`）。重连时重读它，找回换了端口的 Host。 */
    descriptorPath?: string;
    /**
     * 允许接上任何一个 Host，而不比对 `hostId`。
     *
     * 只用于一种情况：扩展启动时**还没有发现文件**（Host 还没起），此时 `descriptor` 是占位值，
     * 拿它去比对 hostId 会永远不匹配、永远接不上。既然这一刻本来就没有 Host，任何 Host 都更好。
     */
    adoptAnyHost?: boolean;
  };

/**
 * 唯一的通道：本机 Host 的 loopback。
 *
 * **不再回落到中继**（ADR-0008 之后）：中继上那条"运行时"入口只能把**明文**的会话事件
 * 广播给设备（中继解不开 E2E，而它是运行时的直连入口）。一旦回落，中继就看到了会话内容，
 * 而"中继零知识"是这个产品的设计前提。何况那条路本来也干不了活——命令是端到端发给 Host 的，
 * Host 不在就没人执行，手机只会看到一个"只能看、发不出命令"的半残进程。
 *
 * 所以 Host 没起来时**等它**：`resolveEndpoint` 每次重连前都重读发现文件，
 * Host 起起来（哪怕换了端口）就会自己接上。约定仍是「先起 Host，再起 Pi」。
 */
export async function resolveRuntimeTransport(input: {
  onConnectionStateChange: (state: RelayRuntimeConnectionState) => void;
  descriptorPath?: string;
  log?: (line: string) => void;
}): Promise<LoopbackHostTransport> {
  const descriptorPath = input.descriptorPath ?? defaultLoopbackDescriptorPath();
  const descriptor = await readLoopbackDescriptor(descriptorPath);
  if (descriptor === undefined) {
    input.log?.("还没有发现文件：等待本机 Host 启动（不回落到中继）");
  } else {
    input.log?.(`走本机 Host 通道（hostId=${descriptor.hostId} pid=${descriptor.pid}）`);
  }
  return new LoopbackHostTransport({
    // 没有发现文件时给个占位端点：真正的地址由 `resolveEndpoint` 在每次重连前重读。
    // 端口取 1 是为了让"Host 还没起"这件事表现为一次普通的连接失败，而不是打到别的服务上。
    descriptor: descriptor ?? { version: 1, url: "ws://127.0.0.1:1", token: "placeholder", hostId: "", pid: 0 },
    descriptorPath,
    adoptAnyHost: descriptor === undefined,
    onConnectionStateChange: input.onConnectionStateChange,
  });
}

/**
 * 把本机 Host 当作「本地的一条 Relay」接入。
 *
 * 之所以是薄薄一层而不是另写一份：Host 的 loopback 端点说的就是 runtime 侧既有协议，
 * 差别只有 URL 与凭据。重写一份的唯一确定后果是两侧语义慢慢漂移。
 */
export class LoopbackHostTransport extends RelayRuntimeTransport {
  constructor(options: LoopbackHostTransportOptions) {
    const { descriptor, descriptorPath, adoptAnyHost, ...rest } = options;
    super({
      ...rest,
      relayUrl: descriptor.url,
      credential: descriptor.token,
      path: LOOPBACK_PATH,
      // Host 重启会换一个随机端口与 token：重连前重读发现文件，否则还活着的 Pi 进程
      // 会一直重连死端口——进程在跑，Host 却再也发现不了它。
      // hostId 变了说明这是**另一台** Host（不同 stateDir），不跟过去。
      resolveEndpoint: async () => {
        const fresh = await readLoopbackDescriptor(descriptorPath);
        if (fresh === undefined) return undefined;
        if (adoptAnyHost !== true && fresh.hostId !== descriptor.hostId) return undefined;
        return { relayUrl: fresh.url, credential: fresh.token };
      },
    });
  }
}
