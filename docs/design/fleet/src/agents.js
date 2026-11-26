// 每个 Agent 的身份：名字、分工、颜色、讯息形状、轨道、会话内容
import { SHAPE } from './gfx/fx.js';
export const AGENTS = [
  { key: 'claude', any: '先看了相关的文件，问题出在最近一次改动。已经改好，并补了一个用例，测试全部通过。', name: 'Claude Code', role: '建造', ui: '#f0b48c', hot: '#ff8d45', shape: SHAPE.claude, scale: .36, orbit: { rx: 12.5, rz: 20, y: 9, dy: 1.4, w: .050, ph: .5 },
    sessions: [{ title: '修复登录页在小屏上的溢出', ask: '登录页在小屏上会横向溢出，修一下', reply: '问题在 LoginForm 的固定宽度，改成自适应后，三个断点都正常了。顺手把错误提示挪进表单里，避免把按钮顶出屏幕。测试 42 项全部通过。', cmd: 'npm run test -- login', files: 3 }] },
  { key: 'codex', any: '已经定位到原因并改好，一共动了 3 个文件。构建和测试都通过了。', name: 'Codex', role: '装配', ui: '#77d6c7', hot: '#35d6b4', shape: SHAPE.codex, scale: .36, orbit: { rx: 12, rz: 19, y: -10.5, dy: 1.2, w: .040, ph: 2.3 },
    sessions: [{ title: '给导出功能补上测试', ask: '导出功能没有测试，补上', reply: '补了 9 个用例，覆盖空表、超长单元格和取消导出。发现取消时临时文件没有清理，已经一起修好。', cmd: 'git push origin main', files: 5 }] },
  { key: 'kimi', any: '相关内容已经读完，整理成五点：背景、目标、分歧、结论和下一步。需要的话可以继续展开其中任何一点。', name: 'Kimi Code', role: '研读', ui: '#bdc6ff', hot: '#5f9bff', shape: SHAPE.kimi, scale: .37, orbit: { rx: 10.5, rz: 17, y: 14.5, dy: 1.6, w: .060, ph: 4.1 },
    sessions: [{ title: '读完 120 页需求文档', ask: '把这份需求文档读完，列出互相冲突的地方', reply: '一共找到 4 处冲突：登录有效期写了 7 天和 30 天两个值；导出上限前后不一致；离线模式缺少同步规则；审批人可以审批自己。', cmd: '读取 docs/requirements.pdf', files: 1 }] },
  { key: 'opencode', any: '已经按现有组件重新搭好，交互保持不变，旧代码也一起清理了。', name: 'OpenCode', role: '成型', ui: '#a99bff', hot: '#9a6bff', shape: SHAPE.opencode, scale: .33, orbit: { rx: 13.5, rz: 22, y: -3.5, dy: 1.0, w: .034, ph: 5.4 },
    sessions: [{ title: '把设置页迁到新组件', ask: '设置页换成新组件库', reply: '设置页的 6 个分区已经全部换成新组件，开关和列表的交互保持不变，截图对比没有差异。', cmd: '写入 src/settings/*.tsx', files: 11 }] },
  { key: 'openclaw', any: '已经整理完成，移动过的内容都可以撤回。', name: 'OpenClaw', role: '搬运', ui: '#ff8a75', hot: '#ff5540', shape: SHAPE.openclaw, scale: .34, orbit: { rx: 10.5, rz: 17, y: -14.5, dy: 1.2, w: .046, ph: 1.0 },
    sessions: [{ title: '整理下载文件夹', ask: '下载文件夹太乱了，整理一下', reply: '按类型归到 7 个文件夹，移走 3.2 GB 重复文件。有 5 个安装包超过半年没打开过，放进了待删除。', cmd: '移动 248 个文件', files: 248 }] },
  { key: 'pi', any: '查过了，原因只有一处，已经修好，前后对比的数据留在了记录里。', name: 'Pi', role: '侦察', ui: '#f0a9d3', hot: '#ff7fc0', shape: SHAPE.pi, scale: .32, tri: ['#ff6a5e', '#4fb4e6', '#ffc04a'], orbit: { rx: 13, rz: 22, y: 3, dy: 2.4, w: .085, ph: 3.2 },
    sessions: [{ title: '查出昨晚接口变慢的原因', ask: '昨晚接口突然变慢，查一下', reply: '23:10 开始的慢查询来自订单列表，少了一个联合索引。加上以后，接口从 1.8 秒降到 90 毫秒。', cmd: '运行 EXPLAIN ANALYZE', files: 2 }] },
  { key: 'deepseek', any: '逐层排查后找到了根因，是一处没有释放的资源。修复后连续运行一小时，没有再出现。', name: 'DeepSeek', role: '深潜', ui: '#a9bbff', hot: '#4d7dff', shape: SHAPE.deepseek, scale: .38, glow: .56, orbit: { rx: 12, rz: 18, y: -6.5, dy: 1.4, w: .042, ph: 2.9 },
    sessions: [{ title: '定位偶发的内存泄漏', ask: '后台跑久了内存一直涨，找出原因', reply: '泄漏在图片缓存：取消下载时没有移除监听。修复后连续运行 6 小时，内存稳定在 180 MB。', cmd: '附加调试器', files: 2 }] },
  { key: 'hermes', any: '已经整理好并发给相关的人，收到回复后会再告诉你。', name: 'Hermes Agent', role: '信使', ui: '#f1d58a', hot: '#ffcf5a', shape: SHAPE.hermes, scale: .34, orbit: { rx: 12.5, rz: 19, y: 6.2, dy: 1.6, w: .062, ph: 5.2 },
    sessions: [{ title: '把会议纪要发给大家', ask: '整理今天的会议纪要，发给参会的人', reply: '纪要已整理成 5 条待办，发给了 8 位参会者，其中 2 条需要你确认负责人。', cmd: '发送 8 封邮件', files: 1 }] },
];
