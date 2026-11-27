# ADR-0100：CI 与发版流水线加速

日期：2026-11-27 · 状态：CI-PERF-04–10 已在独立工作树实现并通过本地单元测试、静态检查与 macOS Qt 构建／CTest 验证；未推送远端、未部署。线上 GitHub Actions 实测耗时与用户验收待完成。

关联：[部署说明](../deployment.md)、[协议兼容](0064-protocol-compatibility.md)、[Host 启动与反馈](0081-host-startup-blocking-and-feedback.md)、[测试与构建规则](../../AGENTS.md#测试)。前序编号：`CI-PERF-01`（[`ci-changes.mjs`](../../scripts/ci-changes.mjs)）、`CI-PERF-02`（[`test_mobile_toolchain.py`](../../scripts/test_mobile_toolchain.py)）、`CI-PERF-03`（[`prepare-incremental-build.mjs`](../../scripts/prepare-incremental-build.mjs)）。

## Context

基于仓库 `2026-11-19` 至 `2026-11-27` 最近 100 次 GitHub Actions 运行记录及 `v0.1.25`（候选提交 `ce0acf7f`）发版实测，整套发版耗时长达数小时由单次步骤慢、跨工作流重复检查、跨洋单连接上传及原生回归滞后共同造成：

1. **Relay 部署上传瓶颈（`#45818130598`，总耗时 33.5m）**：四个已压缩 Host 产物（Windows 安装包／便携包、macOS双架构 DMG）合计 `443.8 MB`，原流程二次 `gzip` 打包后通过单条跨洋 `scp` TCP 连接上传服务器，受高 RTT 拥塞窗口限制仅上传一步耗时 `1,201s`（20.0m），且重试或单平台未变时仍重传全量字节。
2. **同提交重复门禁与主干全局锁**：同一发布提交在 `CI`、`Windows Host build`、`macOS Host build`、`Relay deploy` 中重复执行 4 遍 `Core checks`（每次约 `4–8.3m`）；`ci.yml` 的 `ci-main-pipeline` 将测试与部署绑在同一不可取消互斥组内，连续合并时后续提交排队超过 `20m`（如 `#45729621231` 排队 `21.9m`）。
3. **Host C++／Qt 重复编译与串行测试**：[`CMakeLists.txt`](../../packages/windows-host/CMakeLists.txt) 未抽取共用库，`HostController.cpp`、`CredentialStore.cpp`、`StartupSettings.cpp`、`DiagnosticLogModel.cpp`、`NeuSurface.cpp` 及 QML 资源在主程序与 15 个测试目标间重复 MOC 与编译达 6–8 次；Windows 构建（`#45804774369`）链接 `OrbisHost.exe` 仅 `68s`，而测试目标耗时 `198s`；macOS Intel（`#45804781020`）在 `--parallel 2` 且无编译器缓存条件下构建耗时 `488s`（8.1m），串行 `ctest` 耗时 `141s`；`install-qt-action` 命中缓存时仍每次重装 Python 下载依赖（macOS Intel `132s`、Windows `64s`）。
4. **PR 缺乏原生 Host 编译门禁**：日常 PR 与 `main` `CI` 不编译 `packages/windows-host` 也不运行 `ctest`，导致 QML／C++ 回归集中在手动触发发布构建时暴露（近 100 次记录中 `Windows Host build` 13/20 失败、`macOS Host build` 8/14 失败），每次修复重跑叠加 macOS 托管池排队放大至数小时。
5. **macOS 串行时间戳签名与固定大镜像**：[`macos-sign.py`](../../scripts/macos-sign.py) 对包内 `141` 个 Mach-O／Bundle 串行发起 Apple RFC 3161 网络时间戳签名，并串行启动 `282` 次 `codesign --display` 校验；DMG 固定分配 `3g` HFS+ 空间。
6. **iOS／Android／Windows 构建缓存与压缩损耗**：[`ios-build.yml`](../../.github/workflows/ios-build.yml) 的 Swift `.build` 缓存无 `restore-keys`，任意源码改动均全量重编 `572s`（9.5m），且 `ios-testflight.yml` 在同提交已通过 `CI` 后仍重跑 `check-ios.sh`；[`android-build.yml`](../../.github/workflows/android-build.yml) 在独占 CI 虚拟机上沿用本机防争用的 `--no-daemon --max-workers=2` 分两步冷启动 Gradle 且未缓存 `relayquic.aar`；Windows 便携包采用单线程 `Compress-Archive` 压缩 `101.5 MB` 载荷。

## Decision

### 1. 安全与门禁不变边界

性能优化不削弱任何既有交付门禁：
- 官网 `/downloads/` 与 `/v1/site` 继续由服务器本地只读目录直接服务，保留客户端与内置更新器的同源下载路径、完整 SHA-256 强校验、新目录原子切换及候选容器失败回滚。
- 仅当同一仓库、同一 40 位 `head_sha` 的已完成 `CI` 运行中所有必需子任务均为 `success` 时才复用检查结果；文档跳过或部分跳过的运行不得绕过任何检查。
- 签名身份、Hardened Runtime、精确 entitlements、安全时间戳、无调试权限校验、Apple 公证票据装订及 Android 证书指纹钉死保持原判据。
- 本机多工作树构建租约与串行 Gradle 规则保持不变；并发参数放宽仅作用于一次性独占 GitHub Actions 虚拟机。

### 2. 实施项

| ID | 决策摘要 | 实现与测试指针 |
| --- | --- | --- |
| `CI-PERF-04` | Relay 部署先按服务器当前 `downloads-current` 中已校验的 SHA-256 过滤未变更二进制，以无二次压缩的 `.tar` 打包变更项与 `.sha256` 清单，超过单块阈值时拆分为 `16 MiB` 分片经 8 个独立 `scp` 进程（禁用 `ControlMaster` 以建立独立 TCP 拥塞窗口）并发上传并在远端重验归档哈希；`prepare-host-downloads.py` 支持复用 `previous` 中同哈希二进制并在切换前复算全部 SHA-256。 | [`upload-host-downloads.py`](../../deploy/upload-host-downloads.py)、[`prepare-host-downloads.py`](../../deploy/prepare-host-downloads.py)、[`relay-deploy.yml`](../../.github/workflows/relay-deploy.yml)、[`test_upload_host_downloads.py`](../../scripts/test_upload_host_downloads.py)、[`prepare-host-downloads.test.mjs`](../../scripts/prepare-host-downloads.test.mjs) |
| `CI-PERF-05` | `macos-host-build`、`windows-host-build`、`relay-deploy`、`ios-testflight` 在 preflight 中核验当前 `GITHUB_SHA` 是否已有必需子任务全绿的 `CI` 运行，满足时跳过重复 `Core checks`／`check-ios.sh`；移除 `ci.yml` 外层 `ci-main-pipeline` 串行锁使多提交并行检查，由 `relay-deploy` 独占锁配合 `git merge-base --is-ancestor` 阻止旧提交回退覆盖已部署的新提交；提供保留原始 workflow 路径溯源的单命令发布编排脚本。 | [`ci-verified-checks.mjs`](../../scripts/ci-verified-checks.mjs)、[`release-orchestrate.mjs`](../../scripts/release-orchestrate.mjs)、[`ci.yml`](../../.github/workflows/ci.yml)、[`relay-deploy.yml`](../../.github/workflows/relay-deploy.yml)、[`ci-verified-checks.test.mjs`](../../scripts/ci-verified-checks.test.mjs) |
| `CI-PERF-06` | `packages/windows-host/CMakeLists.txt` 抽取 `orbis-host-support`、`orbis-host-controller`（区分标准构建与 `ORBIS_QA_BUILD=1`）、`orbis-neu-surface` 静态库及 `orbis-test-host-qml` 资源对象库，消除测试目标对核心源码的重复编译；为窗口化 Qt Quick 测试声明 `RESOURCE_LOCK gui_window`，启用 `ctest --parallel 4`；双端 Host 工作流接入 `sccache`、直接缓存 Qt 目录跳过重复安装 `aqtinstall` 并按全部核心并行构建。 | [`CMakeLists.txt`](../../packages/windows-host/CMakeLists.txt)、[`windows-host-build.ps1`](../../scripts/windows/windows-host-build.ps1)、[`macos-host-build.yml`](../../.github/workflows/macos-host-build.yml)、[`windows-host-build.yml`](../../.github/workflows/windows-host-build.yml) |
| `CI-PERF-07` | `ci-changes.mjs` 新增 `hostNative` 分类：当改动涉及 `packages/windows-host/`、`windows-host-build.ps1` 或相关构建工作流时，在 PR 与 `main` `CI` 并行运行基于 Qt 缓存与 `sccache` 的轻量 CMake 编译与 `ctest` 门禁，且纯 `packages/windows-host/` 改动不再触发无关的自动 Relay 部署。 | [`ci-changes.mjs`](../../scripts/ci-changes.mjs)、[`ci-pipeline.yml`](../../.github/workflows/ci-pipeline.yml)、[`ci-changes.test.mjs`](../../scripts/ci-changes.test.mjs) |
| `CI-PERF-08` | `macos-sign.py` 按嵌套包含拓扑分层（最内层 Mach-O／原生扩展 → `.framework` 等嵌套 Bundle → 顶层 `.app`），同层无包含关系的目标并发请求时间戳签名并在整体深层验签后并发校验身份与调试权限；DMG 镜像大小按实际 `.app` 体积加 `128 MiB` 余量动态创建。 | [`macos-sign.py`](../../scripts/macos-sign.py)、[`macos-host-build.yml`](../../.github/workflows/macos-host-build.yml)、[`test_macos_sign.py`](../../scripts/test_macos_sign.py) |
| `CI-PERF-09` | `ios-build.yml` 与 `ios-testflight.yml` 为 `ios/Orbis/.build` 补充同工具链前缀 `restore-keys`：精确命中继续跳过编译，部分命中恢复前次编译产物后仍执行 `swift build --build-tests` 完成增量编译。 | [`ios-build.yml`](../../.github/workflows/ios-build.yml)、[`ios-testflight.yml`](../../.github/workflows/ios-testflight.yml) |
| `CI-PERF-10` | `build-relay-quic.py` 对 Go 版本、NDK 版本、构建脚本及 `native/relayquic` 全部文件计算指纹落盘 `.stamp`，连同 `relayquic.aar` 一并纳入 Actions 缓存；`android-build.yml` 在独占 CI 虚拟机启用 `--parallel --max-workers=4` 复用 Gradle／Kotlin 守护进程；Windows 打包优先使用多线程 `7z.exe` 生成相同目录结构的便携 ZIP。 | [`build-relay-quic.py`](../../scripts/build-relay-quic.py)、[`android-build.yml`](../../.github/workflows/android-build.yml)、[`windows-host-build.ps1`](../../scripts/windows/windows-host-build.ps1)、[`test_mobile_toolchain.py`](../../scripts/test_mobile_toolchain.py) |

## 验证与交付状态

- **实现位置**：独立工作树 `/Volumes/WD1TB/Orbis/worktrees/ci-release-acceleration`（分支 `ci-release-acceleration`）。
- **本地自动验证**（原始日志保存在本工作树 `.artifacts/ci-release-acceleration/`）：
  - Python 构建／签名／DMG／QUIC 工具链／增量分片上传单元测试：35 项全部通过（[`python-tests.log`](../../.artifacts/ci-release-acceleration/python-tests.log)）。
  - Node Vitest 套件（`ci-changes`、`ci-verified-checks`、`prepare-host-downloads`、`build-relay-web`、`prepare-incremental-build` 共 19 项）与定向 ESLint 检查全部通过（[`vitest-eslint.log`](../../.artifacts/ci-release-acceleration/vitest-eslint.log)）。
  - `.github/workflows/*.yml` 全部 12 个工作流 YAML 结构与依赖图静态解析通过（[`workflow-yaml-check.log`](../../.artifacts/ci-release-acceleration/workflow-yaml-check.log)）。
  - 本机 macOS Qt `6.8.3` 全目标 Release 构建与并行 `ctest --parallel 4` 验证见 [`qt-ctest.log`](../../.artifacts/ci-release-acceleration/qt-ctest.log)。
- **未覆盖与待验收项**：
  - 尚未推送到 GitHub 远端运行真实托管 Runner（`windows-latest`、`macos-15`、`macos-15-intel`、`ubuntu-latest`），`sccache` 跨运行命中率、8 路并发 `scp` 实测吞吐与线上端到端发版总时长待合入后首次线上运行确认。
  - 状态：本地实现与自动验证完成，未部署，待用户验收。
