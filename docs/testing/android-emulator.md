# 本机 Android 模拟器共用入口

所有本机 Orbis agent / 工作树使用同一个设备入口：

```sh
python3 "$HOME/.orbis/tools/ui-regression/android-emulator.py" doctor
python3 "$HOME/.orbis/tools/ui-regression/android-emulator.py" smoke --task "检查安卓模拟器"
python3 "$HOME/.orbis/tools/ui-regression/android-emulator.py" run --task "本次任务名称" -- sh -c '
  set -eu
  adb shell getprop sys.boot_completed
  # 在此运行安装、取图或设备测试命令。
'
```

从工作树根目录执行；在其他目录执行时加 `--worktree /绝对路径/工作树`。Python 部分只用标准库，另需已安装的 Android SDK、`lsof` 和 `ps`；当前已在本机 macOS 验证。Windows 继续使用已有 owner / lease 工具，不能据本页绕过其校验。

工具按已有本机约定放在 `~/.orbis/tools/ui-regression/`，不纳入 Git；本页和 [UI 回归方案](ui-regression.md) 是仓库入口。新 agent 不依赖旧聊天上下文，也不应从 `.artifacts/` 复制某次任务的临时运行器。工具缺失时先报告本机安装缺口，不退回未隔离的 ADB。

本机工作树的 AGENTS.md / CLAUDE.md 通过共享同步器更新设备入口、12 台登记上限和强制解锁责任，原有 UI 基线保持；实际同步范围以当次 Git worktree 清单和备份 manifest 为准。新建工作树后执行 `python3 "$HOME/.orbis/tools/ui-regression/sync-agent-guides.py" --worktree /新工作树绝对路径`；同步器保留旧指南备份，只更新 Git 忽略的入口文件，双入口已不一致时拒绝覆盖。

## 借用与命令

- `doctor` 列出 API 35 候选设备、占用状态及不兼容 / 文件缺失的排除原因，不启动服务或设备。
- `smoke` 借用池内设备，验证启动、15 次 shell 响应以及 1 MiB 上传的 SHA-256，再清理自己的探针文件和运行资源。
- `run -- <前台命令>` 在设备就绪后执行命令，结束后统一清理。需要查看窗口可加 `--visible`；命令必须留在前台，不用 `nohup` / `setsid` 脱离运行器。
- 默认固定使用 `pool.json` 的 `sharedDevices.android`（本机为 `Orbis_UI_Polish_35`）；`--device` 可固定选择池内其他已登记、具有 loopback serial 的设备，繁忙时不会换机。两端先排全机单台名额，每 20 秒复查，`--queue-wait-seconds` 默认不限时，`0` 表示立即检查；取得名额后的设备 / 80% 内存准入由 `--wait-seconds` 控制，默认 600 秒。超时不抢锁；运行器不会新增、克隆或重登记设备。
- SDK 按 `--sdk`、工作树 `android/local.properties`、SDK 环境变量和默认安装目录查找。AVD 目录取自共享池登记，不把本机磁盘路径写死进运行器。
- 可配置 `--boot-timeout`、`--command-timeout`、`--output`；输出目录必须尚不存在。默认证据为调用方工作树的 `.artifacts/android-emulator/<owner>/`。

运行器持有全程 `simulator-run.lock`，在池的 `registry.lock` 内分配设备锁和 `adb-ports/<port>.lock`；不会在等待设备时一直占住 registry。固定设备池 iOS / Android 合计上限已按 2026-11-03 用户追加要求改为 12 台（5 台 iOS、7 台 Android），见 `AGENTS.md` / `CLAUDE.md`。两端合计同时只运行 1 台；其他 agent 即使选择不同设备也必须排队，登记容量不代表并行额度。

2026-11-03 用户明确授权将固定池补齐至 10 台：保留 3 台 iOS 和 2 台原有 Android，新增 `Orbis_UI_Regression_35_2` 至 `Orbis_UI_Regression_35_6` 五台 API 35。新 AVD 与注册文件均在 `/Volumes/WD1TB/Android/avd/`；使用已安装的 API 35 ARM64 系统镜像和独立初始数据，1080×2400 / 420 dpi、2 核、2048 MiB 内存。合计 6 台 API 35 自动回归设备，另 1 台 API 37 预览设备保持原用途。永久登记不代表常驻启动，空闲设备保持关闭，借用结束即释放运行资源。

同设备基线 / 候选对照应在一次 `run` 内顺序完成；跨会话必须根据前次 `session.json` 的 `device.id` 使用 `--device` 固定回同一台，不能仅假定默认配置始终不变。`allocation.json` 记录本次选择、已忙设备和排除原因。

运行器给子命令注入：

| 变量 / 命令 | 用途 |
| --- | --- |
| `adb`、`$ORBIS_ADB` | 受当前会话约束的包装器，自动指定私有端口和池内 serial |
| `$ANDROID_SERIAL`、`$ORBIS_ANDROID_SERIAL` | 本次独占设备的固定 serial |
| `$ORBIS_ANDROID_EVIDENCE` | 本次日志、session 元数据和结果目录 |
| `$ORBIS_ANDROID_SESSION` | 当前会话的 `session.json` |

普通 `adb -s "$ANDROID_SERIAL" ...` 仍可用；包装器拒绝其他 serial / 端口、连接其他设备以及 `start-server` / `kill-server` 等生命周期命令。不要在子命令里调用 SDK 的绝对路径 adb、改写 ADB 环境或重新启动 emulator。退出后留下的包装器会拒绝继续使用旧会话。

## 已有 UI 命令的用法

先按构建租约规则构建 / 保存本任务 APK，再把已有设备命令放进 `run`：

```sh
python3 "$HOME/.orbis/tools/ui-regression/android-emulator.py" run --task "Android UI 回归" -- sh -c '
  set -eu
  adb install -r -t --no-streaming android/app/build/outputs/apk/debug/app-debug.apk
  adb install -r -t --no-streaming android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
  adb shell dumpsys package com.orbising.orbis > "$ORBIS_ANDROID_EVIDENCE/installed-package.txt"
  adb shell am instrument -w -r \
    -e notClass com.orbising.orbis.IsolatedHostPairingInstrumentedTest \
    com.orbising.orbis.test/androidx.test.runner.AndroidJUnitRunner
  adb pull /sdcard/Android/data/com.orbising.orbis/files "$ORBIS_ANDROID_EVIDENCE/screenshots"
'
```

若 APK 仍位于共享构建目录，读取 / 安装期间必须持有该构建租约，或先在租约内复制到本任务证据目录并记录哈希。设备入口不替代构建锁，不负责构建，也不自动判定 UI 验收。`run` 原样返回子命令退出码；`am instrument` 即使用例失败也可能返回 0，必须检查 `command.log` 中的用例状态、完成标记、失败与 assumption，按 [UI 回归方案](ui-regression.md) 做同设备对照。浅 / 深色、大字和动画设置由测试任务决定，入口不会默默改变外观基线。

## 固定恢复措施

2026-11-03 排障确认本机 ADB 37.0.1 存在 mDNS 服务名解析的 `SIGABRT`，旧临时脚本还曾把 5037 / 5123 混用。共用入口固定采取：

1. 任务私有前台 ADB 服务，`ADB_MDNS=0`，`--one-device __orbis_no_usb__`，只显式连接借用的模拟器。
2. `-P`、`ANDROID_ADB_SERVER_PORT`、`ADB_SERVER_SOCKET` 同源生成，覆盖继承的冲突设置；独立保留 ADB / emulator 的 PID 和日志。
3. 命令运行期间检查两个进程；服务退出时报告原因并停止本次任务，不自动重放安装 / 测试，不影响其他服务或设备。
4. 正常退出、非零退出、超时、SIGINT / SIGTERM 均先结束自己的命令进程组，恢复并核对字号、动画倍率、夜间模式、屏幕超时，再结束自己的 emulator / ADB。确认退出、端口空闲且 owner 匹配后释放锁。

日志包括 `adb-server.log`、`emulator.log`、`command.log`（run）、`session.json`、`original-settings.json`、`result.json`、`cleanup.json`。中途断电 / SIGKILL、失去连接无法恢复设置、归属变化或残留进程会保留锁并明确报告 `cleanup-required`；依据 owner / PID / 实际设备状态核实后再处理，禁止仅按锁龄回收。不要全局 `adb kill-server`，也不要把失联直接当作模拟器本体崩溃。

所有 agent 用完必须核验清理结果及原 owner 不再占用，主 agent 还须核对子任务证据。忘记解锁、重启残留、不可终止进程和设置恢复失败，按 [共享资源解锁责任与遗留锁恢复](resource-lock-recovery.md) 处理；命令退出或删除锁文件都不等于设备可复用。

## 验证记录

脚本测试：

```sh
python3 -m unittest discover -s "$HOME/.orbis/tools/ui-regression" -p test_android_emulator.py -v
```

2026-11-03 本机验证证据位于 `.artifacts/android-emulator/20261103-shared-runner-*`：记录配置污染、独占竞争、传输、真实 UI 运行、非零退出恢复及中断清理。具体结果以各目录 `result.json` / `cleanup.json` 和汇总为准；这验证设备入口，不提升原 App UI feature 的验收状态。

同日第一轮永久池扩容证据位于 `.artifacts/android-emulator/20261103-pool-expansion/`。新设备 `_2` 已由其他 agent 经自动分配借用并安装 App / AndroidTest；`_3`–`_6` 完成启动、15 次 shell 探针、1 MiB 传输 SHA-256 与退出恢复检查。`_6` 首次启动在宿主机高负载下超时，清理成功后使用 `--boot-timeout 600` 重试通过；首次失败日志保留。当轮登记 10 台，后续新增 2 台 iOS 后上限已改为 12 台。设备按需启动，池容量不表示宿主机同时运行全部设备仍具有可比的 UI 性能；性能计时回归须记录宿主机负载并保持同设备、同配置对照。

同轮发现全机 `ps ... command` 在宿主机内存压力下可能超时；入口改为先读内核进程名，再只读取 emulator / qemu 候选的完整参数来确认 AVD 归属，保留归属不明时拒绝借用的规则。相关单元测试覆盖不同 AVD、未声明 AVD、进程退出和扫描失败。

最终工具单元测试 26 项通过。`active-interrupt-retry/verification.json` 记录在新增 `_2` 上真实执行 SIGTERM：退出码 143、六项系统设置恢复、设备 / ADB 租约释放、旧 ADB 包装器拒绝继续操作。首次进程扫描超时也保留在 `active-interrupt/`，未启动设备且清理通过。汇总见同证据目录 `summary.md`。
