# Pi 扩展采用 source-first 的本地开发加载

**Status:** superseded（2026-09-17）——本文的机制已整体移除。当时要解决的问题（Pi/Jiti 无法清除
Node 对 `dist/*.js` 的 ESM 缓存，`/reload` 复用旧模块）改用另一个答案：扩展 manifest 指向
`./dist/index.js`、workspace 依赖走普通 package import，改完扩展 `npm run build` 后由 Host
拉起**全新的 Pi 进程**（`session.activate`），不再依赖 `/reload` 热更新。压垮它的直接原因是
dist 里残留的 `@pi-remote/*/source` 导入让 Node 无法加载（`tsc -b` 单独跑不含当时的改写步骤，
Host 重启即 `ERR_MODULE_NOT_FOUND`）。现行约定见 `AGENTS.md` 的「Pi package 的模块解析」。
以下正文保留作历史记录，其中的做法已不再适用。

## Context

Pi 0.84.4 通过 `jiti.import()` 加载扩展。对于 `package.json` 中声明为
`"type": "module"` 的 `.js` 文件，Jiti 会使用 Node 的原生 ESM `import()`。
Node 按稳定的模块 URL 缓存 ESM；Pi/Jiti 的 `moduleCache: false` 不能清除这份
原生 ESM 缓存。

本仓库的 Pi 扩展及其 workspace 依赖原来都把运行时入口指向 `dist/*.js`：

```text
packages/pi-extension/dist/index.js
  ├─ packages/protocol/dist/index.js
  ├─ packages/runtime-bridge/dist/index.js
  └─ packages/remote-interaction-sdk/dist/index.js
```

因此即使重新 build 更新了磁盘文件，已经运行的 Pi 进程在 `/reload` 后仍可能复用
旧的 ESM 模块实例。只把顶层入口改成 TypeScript 也不够；bare package import
仍可能通过 `exports` 解析到旧的 `dist` 入口。

## Decision

当时的实现采用 **source-first** 的本地开发结构：

- `@pi-remote/pi-extension` 的 Pi manifest 和 package export 指向 `./src/index.ts`；
- `packages/pi-extension/src` 中对本仓库 workspace package 的运行时依赖使用明确的
  `@pi-remote/*/source` export，绕过这些 package 的 `dist` export；
- `protocol`、`runtime-bridge` 和 `remote-interaction-sdk` 的默认 package export
  暂时保持 `dist`，避免把直接运行的 Relay Node 进程切换成 TypeScript 入口；它们
  额外提供仅供 source-first 图使用的 `./source` export；
- `@pi-remote/pi-extension` 的 `files` 清单包含 `src`；
- Pi 仍通过正常的 package 配置加载扩展，不再额外维护一个重复的开发实现或
  wrapper；
- `packages/*/src` 是唯一需要修改的实现源，`dist` 只是 TypeScript 构建生成物，
  不再是本地 Pi `/reload` 的运行时入口。

因此 Pi 本地开发时的模块图变为：

```text
packages/pi-extension/src/index.ts
  ├─ @pi-remote/protocol/source         → packages/protocol/src/index.ts
  ├─ @pi-remote/runtime-bridge/source   → packages/runtime-bridge/src/index.ts
  │                                      └─ @pi-remote/protocol/source
  └─ @pi-remote/interaction-sdk/source  → packages/remote-interaction-sdk/src/index.ts
                                         └─ @pi-remote/protocol/source
```

这些 `.ts` 模块由 Pi 已有的 Jiti 转译路径加载，并受 `moduleCache: false` 控制。
修改本地 workspace package 后，执行 `/reload` 即可重新执行 source 模块图。

## Consequences

### Positive

- 修改 Pi extension 或其本地 workspace 依赖后，不需要先 build 再重启 Pi；
- `/reload` 可以重新读取本地 TypeScript source；
- 不需要维护第二份 extension 代码或开发专用 wrapper；
- package import 和项目 TypeScript source 使用同一份实现，减少开发/运行漂移。

### Trade-offs

- Pi extension 的默认 package export 仍指向编译后的 JavaScript，以保留未来发布
  的正常入口；Pi manifest 通过 `src/index.ts` 进行本地开发，且 source 代码通过
  `@pi-remote/*/source` 执行本地依赖；默认 package import 仍指向 `dist`，因此
  Relay 等直接由 Node 启动的运行时不受影响；
- `npm run build` 仍然有用，用于类型检查、生成声明、验证构建图，并在生成
  `dist` 后把 source-only subpath 改回普通 runtime import；它不是本地 Pi
  `/reload` 生效的前置条件；
- 这种结构暂时不是面向普通 Node `import` 的发布布局。未来发布时应增加独立的
  release packaging/profile，或等待 Pi 提供能够安全清理本地 ESM 模块图的 loader
  模式；不能为了发布入口而把本地开发重新切回稳定 URL 的 `dist/*.js`；
- 首次切换入口后，建议重启一次当前 Pi 进程，使旧的 `dist` ESM 模块实例退出。
  之后 source-first 模块图可通过 `/reload` 更新。

## Verification

在仓库根目录执行：

```text
npm run typecheck
npm test
npm run lint
npm run build
```

然后启动或重新启动 Pi，确认日志中的 `extension_loaded.entryPoint` 以
`packages/pi-extension/src/index.ts` 结尾。修改任意 `packages/*/src` 运行时模块后
执行 `/reload`，应能在不重启 Pi 的情况下看到变更。
