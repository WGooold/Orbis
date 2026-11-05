# 原生 QUIC 合入主分支验证

2026-11-05；来源 feat/native-quic 的 cafca0e、ADR 先行提交 27747a3 / 24a3fc5，集成基线 ef643d4，并纳入主分支 cfcf499 的消息菜单改动。证据根：.artifacts/merges/20261105-native-quic/。本次只做功能与构建验证，没有测速、推送、部署或安装用户设备。

## 合并处理

保留 Host 的协议18/19双向业务适配、每设备 / 路径版本绑定、旧格式封帧前转换和 DSH 已有服务恢复。两段 Relay 承载可分别切换 ws / quic / auto；默认仍为 WS / shared。显式 background 且能力认证接受后使用 ctl > msg > history > catchup > bulk；LAN、原序号槽位、同步 / 文件预算、操作身份与 applied / unknown 语义保持。

发现并修正首次引导互等：Host 在首个有效加密请求之后才确定业务协议，QUIC 手机不能只等 Host ready。Android / iOS 在同一 ctl 流按序发送 HS3 和原有只读 host.lan.request（含当前业务版本）；认证后的 ready 到达前保持其他业务屏障。Android 测试检查该引导真实明文和版本；Apple↔Go 业务夹具改为收到合法引导才发布 ready。四组合旧协议测试使用未修改的已安装 Host0.1.14 schema / E2E 模块，不操作其在线进程或用户数据。

## 自动结果

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript 实现与测试类型 | 通过 | typecheck/、dist/ |
| Node 全量 | 1844通过、0失败、5原条件跳过 | node-full/tests.json |
| Host/参考手机 WS/WS、QUIC/WS、WS/QUIC、QUIC/QUIC | 每列104/104；包括旧18/19严格schema、文件字节、首次ready、重连、业务交接与DSH恢复 | matrix/summary.json、各列JSON |
| Swift核心与真实Apple↔Go | 397项 / 43 suites通过；v2/v3、加密业务、文件、重握手与LAN | swift/run.log |
| Android JVM | 724项：723通过、0失败、1既有opt-in跳过 | android-latest/run.log、source/android/app/build/test-results/testDebugUnitTest/ |
| Go race | 按包 / 测试身份合并59个含子用例事件全部通过，未跳过 | go-race/run.log、go-contract/run.log |
| 双端App | Android Debug APK与iOS通用Simulator App构建、iOS依赖检查通过；已包含最新主分支消息菜单 | android-latest/、ios-latest/ |

Android跳过项为 PublishedProtocol18InteropTest，未提供其独立Node夹具；上述Node四组合实际加载旧模块的互通结果单列，不把此跳过记为通过。Android Go工具下载超时、离线缺少元数据，以及一次跳过生成任务造成的provider依赖错误均保留。随后核对38个原生源码 / 构建脚本逐文件一致并记录AAR SHA-256，显式复用同源码已验证库，正常执行生成任务和全部Kotlin编译 / 单测；见 aar-reuse.json、android-verified-native/、android-final/、android-latest/。第一次Android回归发现新增引导缺protocolVersion，补齐后完整重跑通过，首次失败保留。

Go首次因隔离工作树未生成Relay网站dist资源导致9个契约 / 集成事件失败；补齐正常构建产物后原9项race定向重跑全过，其他已通过用例无需重跑；表内59为逐测试身份最终结果，初次失败仍在原日志中。此过程没有删除、跳过或放宽原断言。

## 设备证据与边界

复用[五流功能报告](native-quic-five-stream-results-20261105.md)的有效设备证据；此次针对合并冲突和新增主分支语义补测，不重复与传输无关的完整UI / 样式矩阵。先前iOS原88项对照的首次3项候选额外失败、复核后双方同样失败及未知根因仍保留，不能宣称完整UI验收通过。真实手机网络体验、iOS17、长期容量、用户手动与发布门禁继续待验证；手动回归由用户自行安装，不把构建成功当作验收。

所有主工作树未提交修改和索引先备份，再做逐文件三方合并；仅本任务提交进入Git。清理各构建runner的result / cleanup；iOS首次构建成功后遗留两个本任务ibtoold，核对原身份后在维护互斥下定向停止、确认无资源引用并释放原租约，见 ios-build-recovery/cleanup.json。最新双端构建cleanup均正常。最终进程 / 租约和主树保护核验见 cleanup-audit.json、integration-result.json；本次未借用模拟器或真机。
