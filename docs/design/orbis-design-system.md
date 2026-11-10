# Orbis 设计规范

| | |
| --- | --- |
| 版本 | 1.1 / 2026-11-09 |
| 适用 | Android（Compose）、iOS（SwiftUI）、Windows / macOS Host（Qt/QML）、Relay 官网 |
| 地位 | 唯一的完整规范。设计系统（tokens、组件、预览）与可点交互稿都由它推导，冲突时以本文为准 |
| Token | 全部数值在第 12 节逐项列出，与设计系统的 `tokens.json` 同源 |
| 状态 | 设计目标；2026-11-08 起按 [ADR-0070](../adr/0070-unified-design-and-interaction.md) 落地，自动验证与用户安装验收分别记录 |

## 目录

- 1 定位与原则
- 2 内容与语气
- 3 视觉基础速览
- 4 颜色
- 5 材质
- 6 字体、间距与尺寸
- 7 图标
- 8 交互状态
- 9 动效
- 10 布局与页面
- 11 组件
- 12 Token 一览
- 13 落地映射
- 附录 A 现状审视
- 附录 B 修订记录

---

## 1 定位与原则

Orbis 是"从手机连接电脑上的 Agent"的原生客户端：Android（Compose）、iOS（SwiftUI）、Windows / macOS Host（Qt/QML）和 Relay 官网共用这一套设计语言。它的面孔是**一块柔和的瓷白雾蓝底板**：控件从底板里凸起、输入和选中压进底板，彩色只出现在墨色上，留给四个 Agent 和状态。

每一处界面先满足六条原则，再看具体组件：

1. **一块底板。** 每个页面都铺 `surface-base`，层次只靠成对柔影（`highlight` 左上、`shade` 右下）和三层明度（`surface-base` < `surface-lift` < `surface-top`）。凹陷不换底色：它是同一块材料被按下去，只靠内阴影显出更低。不画黑色描边、不用纯黑阴影、不给某个页面另配底色——外观切换时所有页面一起变。
2. **深度有含义。** 凸起（`raised-*`）= 可以点、独立成块；凹陷（`inset-*`）= 承载输入、已选中、正被按住。不要用凹陷装饰一个静态标签，也不要让输入框凸起。
3. **彩色只上墨。** 材质永远无彩；色相只出现在文字、图标、状态点和焦点上，并且只属于三种主人：Orbis 自己（`accent`）、某个 Agent（`agent-*`）、某种状态（`success` / `warning` / `danger`）。唯一的着色底是批量选择的 `accent-soft`。
4. **一块内容一个外框。** 只有最外层表面投外阴影；里面凸起的面板、按钮、胶囊是平的明度台阶，凹陷的元素（代码块、目录托盘、选中项）在任何层级都保留内阴影；圆角同心（子圆角 = 父圆角 − 间距）。
5. **几何稳定。** 状态变化不移动布局：图标与反馈用固定槽位，数字等宽，选择标记的位置提前留好，加载用同尺寸替换。
6. **动效延续身份。** 每一次变化都是屏幕上已有之物的连续变形——按下沉入、松开浮起、页面从右侧推入、折叠按自然高度收放。没有凭空出现的东西；减少动画时直接到终态。

## 2 内容与语气

- 中文优先，英文同步（ADR-0063）。句子短，先说结果，不寒暄：「已加入下载队列」「未确认是否送达」「电脑离线」。
- 操作用 2–4 字动词：切换、应用、重新发送、放回输入框、取消配对、查看全部 11 个工作目录。危险操作写清对象：「取消配对 workstation？」。
- 状态词固定一套：空闲 / 运行中 / 等待审批 / 已排队 / 发送中 / 已连接 / 局域网 / 中继 / 重连中 / 已断开。同一状态全 App 只用一个词。
- 解释后果，不解释机制：「电脑上的会话与历史不受影响，之后可以重新扫码配对」，而不是协议细节。
- 功能文案直接写操作或状态；明显的功能不配解释性小字，操作后果尽量写进按钮。必须说明的非显然后果由小型 info 图标展开提示。不要用 `·` 作为分隔符；信息之间优先用独立布局，文本列表用逗号或顿号。
- 中英混排时中英之间留一个空格（「发给 Codex，/ 命令」）；产品名照原样写：Pi、Codex、DeepSeek、Claude Code、Orbis。
- 不用感叹号、不用 emoji、不用"您"；称呼用户的电脑为「电脑」，不写 Host / runtime 等内部词。
- Slogan 统一写作 **Easy Agents Everywhere**（不是 EveryWhere）。

## 3 视觉基础速览

以下是第 4–9 节的摘要，便于快速查阅；细则以各节为准。

**颜色。** 四个主题共用同一套语义 token：`light` / `dark`（雾蓝，默认，与瓷白雾蓝图标一致）和 `sage-light` / `sage-dark`（灰绿，设置里的第二外观）。页面底一律 `surface-base`；正文 `ink`，次要信息 `ink-muted`（含占位符），禁用 `ink-faint`；链接、选中标签与主按钮文字用 `accent`；进入某个 Agent 的会话后，`accent` 与 `focus-ring` 换成该 Agent 的颜色（用 `AgentScope` 或给容器加 `ob-agent-scope ob-agent--<agent>`）。所有文字对 `surface-base` / `surface-lift` / `surface-top` 在四个主题里都 ≥4.5:1，`ink-faint` 约 3:1，只给禁用内容和装饰刻度。详见「配色逻辑」。

**字体。** 用系统字体（SF Pro / PingFang SC、Roboto / Noto Sans SC、Segoe UI / 微软雅黑），保证原生断行与动态字号；代码和路径用系统等宽。界面只有四档字号：`title` 20、`body` / `body-strong` 15、`label` / `label-strong` 13、`caption` 12，再加只给数字英雄位用的 `display` 28；字重只有 400 与 600。所有数字等宽（tnum）。任何文字不小于 12。

**间距与尺寸。** 4px 栅格：`space-4 … space-64`。手机页面左右 `space-20`，卡片内边距 `space-16`，卡片之间 `space-12`，抽屉、对话框、底部面板内边距 `space-16`。命中区永远 ≥ `touch-target` 48；输入框与整宽按钮 `field-height` 56；按钮、分段、菜单项、列表行 `control-height` 48；图标圆钮 `disc-md` 40 / `disc-sm` 36 / `disc-xs` 28。

**圆角。** `radius-xs` 为 8，`radius-sm` 为 12，`radius-md` 为 16（控件），`radius-lg` 为 24（卡片、菜单），`radius-xl` 为 32（对话框、底部面板），`radius-full` 用于圆钮、状态点和胶囊。嵌套时子圆角 = 父圆角 − 间距：卡片 24 内缩 12 放 12 的代码块；对话框 32 内缩 16 放 16 的按钮。

**阴影 = 深度。** `raised-sm`（≤36 的小控件）、`raised-md`（默认：按钮、卡片）、`raised-lg`（漂浮层：菜单、对话框、底部面板、短反馈）、`inset-sm`、`inset-md`（输入、用户消息、按下、选中）。凹陷的底色永远等于它所在表面的面，深度只来自内阴影。阴影画在尺寸之外，不参与布局。嵌套的凸起元素用 `flat`；内阴影不受嵌套限制。

**状态。** 按下：表面在 `dur-press` 内由凸起经平面沉到凹陷，字形缩到 `scale-press`、透明度 `opacity-glyph-pressed`；松开 `dur-release` 浮回。选中：凹陷 + `accent` 墨色 + 600 字重。键盘焦点：`focus-ring` 2px 实线外扩 2px；输入框触摸焦点：`focus-halo` 柔光，不改尺寸。禁用：去掉阴影、留 1px `hairline` 轮廓、内容 `ink-faint`，不整体降透明度。加载：图标槽换成同尺寸转圈，按钮宽度不变。完整矩阵见「交互状态」。

**动效。** 时长与曲线全部来自 `dur-*` / `ease-*`，两端常量同源（Android `InteractionMotion.kt` / iOS `InteractionMotion.swift`）。新增：按压深度连续过渡、根标签淡入淡出（fade-through）、外观切换交叉淡化、对话框/底部面板/短反馈的统一进出、骨架占位。完整编排见「动效」。

**布局。** 根级三个平级标签（聊天 / 供应商 / 设置）不压栈；会话、下载、电脑管理整页从右推入并可右滑返回；目录抽屉从左跟手；行级操作用锚点菜单；确认用对话框；选择用底部面板。平板与桌面把内容限制在 `reading-width` 720 内。见「布局与框架」。

## 4 颜色

一套结构，两种材质，四个主题。颜色按"谁在说话"分配，而不是按页面分配。

### 结构：材质 × 墨色 × 主人

| 层 | token | 规则 |
| --- | --- | --- |
| 材质（无彩） | `surface-base` `surface-lift` `surface-top` `highlight` `shade` `hairline` `scrim` | 所有页面、所有表面。只靠明度与成对柔影分层；凹陷不换色。 |
| 墨色（中性） | `ink` `ink-muted` `ink-faint` | 所有文字与图标的默认色。 |
| Orbis 的声音 | `accent` `accent-soft` `on-accent` `focus-ring` | 链接、选中、主按钮文字、焦点、批量选择。只在 Agent 会话之外出现。 |
| Agent 的声音 | `agent-pi` `agent-codex` `agent-deepseek` `agent-claude` | Agent 名称、标记着色；进入该 Agent 的会话后接管 `accent` 与 `focus-ring`。 |
| 状态的声音 | `success` `warning` `danger` | 状态点、状态词、错误与危险操作。永远配文字或图标。 |

一个元素只有一个主人。首页卡片上，"DeepSeek"四个字是 Agent 的声音（`agent-deepseek`），"运行中"前的点是状态的声音（`success`），卡片本身是材质。不要把状态色涂在 Agent 名称上，也不要用 Agent 色表达成功。

### 主题

| 主题 id | 名称 | 何时 |
| --- | --- | --- |
| `light` | 雾蓝，浅色 | 默认。与瓷白雾蓝图标、iOS、Host、官网一致。 |
| `dark` | 雾蓝，深色 | 系统深色。 |
| `sage-light` | 灰绿，浅色 | 设置 › 外观选择“灰绿”时。保留已认可的侧栏灰绿材质。 |
| `sage-dark` | 灰绿，深色 | 灰绿 + 系统深色（石墨绿）。 |

- 外观（雾蓝 / 灰绿）是用户的选择，浅深跟随系统；**两者对整个 App 同时生效**，没有页面私有配色（供应商转盘、侧栏、设置都不例外）。
- 两种材质结构完全相同：同样的三层明度、同样的墨色角色、同样的对比度下限，组件不需要知道当前是哪一种。
- Agent 色与状态色在两种材质下取同一值（浅 / 深各一），所以 Agent 的身份不随外观改变。
- 原 iOS "insetFocus 雾蓝"与"经典蓝"合并为 `light` / `dark`；Android 现有灰绿迁到 `sage-*`，次要文字与主色加深到达标。

### 材质怎么用

| 层 | 用在 | 不要 |
| --- | --- | --- |
| `surface-base` | 页面底、状态栏 / 导航栏、所有凸起表面的面，以及所有凹陷的底 | 在同一屏换另一种底色 |
| `surface-lift` | 凸起卡片里嵌套的凸起元素（工具组、列表头、嵌套按钮）的面 | 再给它加外阴影 |
| `surface-top` | 嵌套两层的凸起元素、桌面端悬停 | 当强调色用 |

**凹陷不换色。** 输入框、输入栏、用户消息、搜索槽、代码块、目录托盘、选中的分段与标签、被按住的控件——底色都等于它所在表面的面（页面上就是 `surface-base`，嵌在 lift 面板里就是 `surface-lift`），深度只由 `inset-sm` / `inset-md` 这组内阴影表达。加深的实色凹槽会读成另一块板，这是侧栏材质（`insetBase = base`）已经验证过的结论。

嵌套规则（取代原 `nestedSurfaceLayer` 的"按下降一层"）：在一个表面里，凸起的子元素升一层（base → lift → top）并去掉外阴影；凹陷 / 按下 / 选中的子元素回到父表面的面并保留内阴影。

### 墨色

- `ink`：正文、标题、激活图标。对三层都 ≥7.9:1。
- `ink-muted`：路径、元数据、分区标题、占位符、未选中标签、次要图标。对三层都 ≥5.1:1——占位符可读。
- `ink-faint`：禁用文字与图标、刻度、空闲状态点。约 3:1，**不承载需要阅读的信息**。
- 文字永远用墨色或某个主人的颜色，不用降透明度的墨色（`alpha 0.38` 一类写法全部替换成 `ink-faint`）。

### Orbis 的强调色

雾蓝下是低彩度墨蓝（`#2F5287` / 深色 `#AFC6E6`），灰绿下是苔绿（`#41603F` / `#A9DDC1`）。刻意压低彩度，原因有二：首页同时出现四个 Agent 色，主色不能与任何一个抢；新拟物靠深度表达选中，颜色只做确认。

用在：链接（「查看全部 11 个工作目录 ›」）、选中标签与分段的文字和图标、主按钮文字、批量选择的轮廓与 `accent-soft` 底、键盘焦点环、Orbis 自己的进度条。不用在：整块填充的按钮、标题、装饰。

### Agent 身份色

| Agent | 浅 | 深 | 标记 | 说明 |
| --- | --- | --- | --- | --- |
| Pi | `#8C3870` | `#F0A9D3` | 自带三色 | **由铁锈改为莓紫**，与 Claude 的色相差从 4° 拉开到约 58° |
| Codex | `#00655D` | `#77D6C7` | 单色，着 Agent 色 | 终端与桌面版同色 |
| DeepSeek | `#3550CF` | `#A9BBFF` | 单色，着 Agent 色 | 品牌蓝 `#4D6BFE` 加深，13 号字达 4.5:1 |
| Claude Code | `#9A4521` | `#F0B48C` | 自带陶土色 | 浅色加深以在灰绿上达标 |

- Agent 名称永远带标记或在其卡片内出现，色相不是唯一区分。
- 会话页给根容器加 Agent 作用域：发送 / 附件圆钮、输入框焦点柔光、链接、选中态都换成 Agent 色；停止仍是 `danger`。
- 首页、目录、设置里，Agent 色只出现在 Agent 名称与标记上。

### 状态色

| token | 含义 | 搭配 |
| --- | --- | --- |
| `success` | 已连接、运行中、完成 | 「已连接」「运行中」、勾号 |
| `warning` | 等人处理或降级：等待审批、未确认送达、重连中、配额将尽 | 「等待审批」、警告图标 |
| `danger` | 出错、离线、发送失败、危险操作、停止 | 「电脑离线」、错误图标、删除 / 取消配对 |
| `ink-faint` | 空闲、未知 | 「空闲」 |

`success` 与 `danger` 明度接近，**必须**配文字或图标；状态点只做辅助。状态只上墨：不要给卡片铺红底或绿底。

### 不要

- 不要为某个页面新造一套 `palette`（转盘页现在的 `#E5E7E9` / `#2C2E31`）。
- 不要用 `Color.White` / `#000` / 纯黑阴影；暗影用 `shade`，高光用 `highlight`。
- 不要用 `MaterialTheme.colorScheme.primary` 直接取主色——在会话里它可能是 Agent 色，取 Orbis 色请明确用 `accent`。
- 不要用渐变、彩色描边卡片、带色左边框。

## 5 材质

光从左上方来。每个表面都是同一块底板的一部分：凸起时左上亮、右下暗；凹陷时反过来画在内侧，底色不变。

### 深度只有五档

| token | 原生参数 | 用在 |
| --- | --- | --- |
| `raised-sm` | shadowScale 0.4（位移 / 模糊 1.6 dp 或 pt） | ≤36 的圆钮、复选框、标签栏项、分段项、状态胶囊、菜单项 |
| `raised-md` | shadowScale 0.65（2.6） | 默认：按钮、40 圆钮、首页会话卡、助手卡、目录外框、设置分组 |
| `raised-lg` | shadowScale 1.0（4） | 漂浮层：锚点菜单、对话框、底部面板、短反馈、抽屉边缘 |
| `inset-sm` | 同 sm，画在内侧 | 选中的标签 / 分段、勾选的复选框、按住的小圆钮、进度槽、Agent 标记槽 |
| `inset-md` | 同 md，画在内侧 | 输入框、搜索槽、输入栏、用户消息、目录托盘、按住的按钮与卡片 |

- 现有 12 档 shadowScale 收为三档：0.32 / 0.35 / 0.4 / 0.42 → **0.4**；0.5 / 0.55 / 0.6 / 0.65 / 0.7 / 0.8 → **0.65**；1.0 / 1.1 → **1.0**。iOS `intensity` 同步按此三档。
- 两条几何约束沿用 `Neumorph.kt` 的注释：模糊 ≤ 位移，衰减收敛到 0；Android 用 BlurMaskFilter 真模糊 + 有界缓存（ADR-0042），不用 `Modifier.blur`。
- 阴影画在尺寸之外，任何尺寸、间距计算都不包含阴影。相邻凸起元素之间至少留 `space-8`，否则柔影会连成一片；需要更紧时改用小一档阴影。
- 灰绿外观的高光更弱（侧栏 r47 高光修正的结论），这已经写进 `sage-*` 的 `highlight` 与阴影 alpha，组件不用特殊处理。

### 一块内容一个外框

```
┌ 会话卡（raised-md，surface-base，radius-lg）────────────┐
│  ▢ Agent 标记槽（inset-sm，底色同卡片）                    │
│  标题 / 路径 / Agent 名称与状态分行显示                    │
│  ┌ 工具组（flat，surface-lift，radius-sm = 24 − 12）─┐   │
│  │  工具行                                               │   │
│  │  工具行                                               │   │
│  └───────────────────────────────────────────┘   │
└──────────────────────────────────────────┘
```

- 只有最外层投外阴影。嵌套的凸起元素用 `surface-lift`（再深一层 `surface-top`），是 `flat`。
- 凹陷在任何层级都保留内阴影，底色等于所在表面的面：卡片里的代码块、目录外框里的托盘、对话框里被选中的分段，都是"同一块材料被按下去"，不换颜色。
- 对话框、底部面板、菜单、短反馈本身就是外框：里面的按钮、分段、列表都按嵌套处理（与 `NeumorphDialog` 提供 `LocalOrbisSurface` 的行为一致）。
- 四角不等的形状不做新拟物表面（柔影只能沿单一半径）；需要气泡尾巴的地方改用等圆角。

### 同心圆角

子圆角 = 父圆角 − 两者之间的内距。常用组合：

| 父 | 内距 | 子 |
| --- | --- | --- |
| 卡片 `radius-lg` 24 | `space-12` | 嵌套面板 `radius-sm` 12 |
| 卡片 24 | `space-16` | 文字（无形状） |
| 菜单 24 | `space-8` | 菜单项 `radius-md` 16 |
| 对话框 / 底部面板 `radius-xl` 32 | `space-16` | 按钮、输入 `radius-md` 16 |
| 分段轨道（若使用）16 | `space-4` | 分段项 12 |
| 开关轨道 `radius-sm` 12 | 4 | 滑块 `radius-xs` 8 |

圆钮、状态点、胶囊用 `radius-full`，不参与同心换算。

**状态点不参与材质**：它是墨，不是表面——没有阴影、没有高光、不发光。空闲是空心圈，有状态是实心点。

### 不画线

- 分隔靠间距与明度台阶；同一表面里确需分隔（工具行、目录托盘里的会话行）时用 1px `hairline` 内阴影，不用 `Divider` 组件。
- 焦点、选中、错误都不加描边改变尺寸：焦点是 `focus-halo` 或外扩的 `focus-ring`，选中是凹陷，错误是 `danger` 文字 + 图标。
- 唯一的描边：批量选择时卡片的 1px `accent` 轮廓（S15），以及禁用控件的 1px `hairline` 轮廓。

## 6 字体、间距与尺寸

### 字号

| 样式 | 字号 / 行高 | 字重 | 用在 |
| --- | --- | --- | --- |
| `display` | 28 / 34 | 600 | 只给数字英雄位：配额剩余、Host 首页统计 |
| `title` | 20 / 28 | 600 | 页面与对话框标题、字标、会话标题（顶栏）、供应商圆盘正对指针的配置名 |
| `body-strong` | 15 / 24 | 600 | 卡片标题、列表行标题、中号与整宽按钮、正文强调 |
| `body` | 15 / 24 | 400 | 消息正文、说明、输入内容、对话框正文、菜单项 |
| `label-strong` | 13 / 20 | 600 | 小按钮、选中标签、Agent 名称、侧栏目录名 |
| `label` | 13 / 20 | 400 | 元数据、状态词、分区标题（`ink-muted`）、标签栏、侧栏会话行 |
| `caption` | 12 / 18 | 400 | 时间、计数、提示、配额周期——全 App 最小字号 |
| `code` | 13 / 20 等宽 | 400 | 代码块、diff、工具输出 |
| `code-sm` | 12 / 18 等宽 | 400 | 卡片与输入栏里的路径、工具参数、协议名 |

- 原四档（20 / 15 / 13 / 12）不变；新增的 `display` 只为数字服务，替代转盘的 21 / 24 和 Host 的 27 / 29 / 33。
- 修订（11-08）：供应商圆盘的配置名改用 `title`。盘外刻度文字只有约 136px 宽，28 号会让多数配置名被截断；`display` 回到只给数字。
- 映射：Host 页面标题 27 → `display` 28；Host 卡片标题 17 / 18 → `body-strong`；Host 正文 14 → `body`；11 及以下 → `caption`（转盘的 8 / 9 / 10 / 11 全部提到 12 或 13）。
- 字重只用 400 与 600；不用大写字母间距做标签，不用 Impact、压缩体或装饰字体。
- 动态字号：所有尺寸按 sp / Dynamic Type 缩放，容器随文字长高（按钮 `min-height` 而非固定高）。
- 数字一律等宽（Android `fontFeatureSettings = "tnum"`，iOS `.monospacedDigit()`，CSS `font-variant-numeric: tabular-nums`），计时、计数、文件大小变化时不推动邻居。
- 路径：等宽 `code-sm`，从中间省略；文件名只省略主名，扩展名完整（S09）。

### 间距

4px 栅格，所有内外边距和间隙只能取这些值：

`space-2` 2，`space-4` 4，`space-6` 6，`space-8` 8，`space-12` 12，`space-16` 16，`space-20` 20，`space-24` 24，`space-32` 32，`space-40` 40，`space-48` 48，`space-64` 64

| 场景 | 值 |
| --- | --- |
| 手机页面左右边距 | `space-20` |
| 抽屉、对话框、底部面板内边距 | `space-16` |
| 卡片内边距 | `space-16`；含嵌套面板时面板距卡片边 `space-12` |
| 卡片之间 | `space-12` |
| 分区之间 / 分区标题上方 | `space-24` |
| 按钮、胶囊、圆钮之间 | `space-8`（48 命中区相邻的圆钮可为 0） |
| 图标与文字 | `space-6`（中号按钮 `space-8`） |
| 卡片内文字行之间 | `space-2` |
| 桌面页面边距 / 分区 | `space-40` / `space-48` |

非栅格旧值就近归档：3 → 4，5 → 6，7 → 8，9 / 10 / 11 → 8 或 12（看是组内还是组间），13 / 14 → 12 或 16，17 / 18 → 16，21 / 22 → 20 或 24。

### 尺寸

| token | 值 | 用在 |
| --- | --- | --- |
| `touch-target` | 48 | 所有可点元素的最小命中区（iOS 也是 48，不再用 44） |
| `field-height` | 56 | 输入框、输入栏静止高度、整宽按钮 |
| `control-height` | 48 | 中号按钮、分段、菜单项、列表行 |
| `control-height-sm` | 40 | 卡片底部与对话框里的小按钮 |
| `bar-height` | 56 | 顶栏与底部标签栏内容高度（系统安全区另加） |
| `disc-lg` | 44 | 首页卡片 Agent 标记槽（不是按钮） |
| `disc-md` | 40 | 默认图标圆钮：顶栏、输入栏附件 / 发送 / 停止 |
| `disc-sm` | 36 | 卡片旁、行内的次要操作（复制、展开、新建） |
| `disc-xs` | 28 | 待确认消息下的密集操作（重发、放回、删除、撤回） |
| `icon-md` / `icon-sm` / `icon-xs` / `icon-inline` | 22 / 18 / 16 / 14 | 见图标规则 |
| `dot` | 8 | 状态点（原 7）：空闲空心、有状态实心；工作中缩到 6 |
| `dot-ring` | 16 | 状态点占位，也是工作中那道弧绕行的圆 |
| `checkbox` | 24 | 复选框与批量选择标记（两端统一为 24） |
| `reading-width` | 720 | 平板 / 桌面上聊天与设置内容的最大宽度 |
| `drawer-width` | 320 | 目录抽屉；平板常驻侧栏 |
| `host-sidebar` | 232 | Host 导航栏 |

圆钮的可见直径与命中区分开：28 / 36 / 40 的圆面都放在 48 的命中区中央；相邻圆钮靠命中区自然留出间距，不再额外加间隙。

### 密度

同一套字号，按场景分两档密度：

- **阅读面**（首页卡片、聊天、设置）：标题 `body-strong` 15、正文 `body` 15，卡片可以两行。
- **导航面**（侧栏、Host 导航栏、目录选择）：一律单行；目录名 `label-strong` 13、会话 `label` 13、元信息 `caption` 12。行高仍是 48 命中区，靠更小的字和单行留出呼吸，而不是把行压矮。导航面不用卡片，层级靠缩进和一条 `hairline` 引导线。

## 7 图标

- 一套图标：Android 用 **Material Symbols Rounded**（400 字重、24 光学尺寸、描线），iOS 用对应的 **SF Symbols**（Regular），Host 与官网用同一套 Material Symbols 的 SVG。对照表见「落地映射」，图标资产在 Icons 组。
- 默认描线；只有被选中的根标签和"已完成"一类实心语义（`check_circle`、停止）用填充版。
- 尺寸只有 `icon-md` 22（40/44 圆钮、标签栏）、`icon-sm` 18（36 圆钮、中号按钮）、`icon-xs` 16（28 圆钮、小按钮、贴字图标）、`icon-inline` 14（12–13 号状态文字里）。图标贴文字时下移 0.125em（S07），独立圆钮里居中。
- 颜色跟随所在文字：默认 `ink`，次要 `ink-muted`，动作着色 `accent` / Agent 色，停止与删除 `danger`。
- 不用 Unicode 字符（◈ ▣ ⌘ ⚙ ≡ ✓ ↗ ⠿）或 emoji 冒充图标；Host 现有字符图标全部换成同名 Material Symbol。
- Agent 标记是第三方品牌资产（Agents 组，附许可）：Pi 与 Claude 保留自身配色，Codex 与 DeepSeek 是单色标记，用 `agent-codex` / `agent-deepseek` 着色。标记只用于识别，不能被拉伸、改色或加效果。
- Orbis 标识：开口方环 + 右上小方块（Logos 组）。应用内顶栏用凹刻字标（`Wordmark`：`title` 字号 + `engrave` 阴影），不再另画图形标。

## 8 交互状态

每个可交互元素都要回答这八个状态。表格是全 App 的唯一答案，组件不得自造。

| 状态 | 表面 | 内容 | 时长 / 曲线 | 备注 |
| --- | --- | --- | --- | --- |
| 静止 | 凸起（`raised-sm` / `-md`） | `ink`，主按钮 `accent`，危险 `danger` | — | |
| 悬停（仅指针设备） | 面换成 `surface-lift` | 不变 | `dur-state` `ease-out` | Host、官网、iPad 指针；手机没有 |
| 按下 | 凸起 → 平 → 凹陷（`inset-*`），底色不变；嵌套时回到父表面的面并出现内阴影 | 字形缩到 `scale-press`、`opacity-glyph-pressed` | 进 `dur-press`，出 `dur-release`，`ease-emphasized` | 指针落下立即响应，无最短按住；滚动或拖拽接管时立刻取消 |
| 松开 / 触发 | 浮回 | 字形回位；成功类操作的图标可做一次 `scale-pop` | `dur-release` | 点击在抬起时触发，不等动画 |
| 选中 | 凹陷保持 | `accent`（会话里为 Agent 色）+ 600；根标签图标换实心 | 交接 `dur-selection` | 旧选中项同时浮起：深度"交接"，而不是瞬间跳 |
| 批量选中 | 深度不变 | 卡片铺 `accent-soft`，从触点向外扩散；1px `accent` 轮廓；右侧选择标记打勾 | `dur-selection` `ease-out` | 标记槽在非多选时也占位（透明） |
| 键盘焦点 | 不变 | 外扩 2px 的 `focus-ring` 实线环，间隔 2px | 即时 | 只在 `:focus-visible`；触摸聚焦输入框改用 `focus-halo` |
| 禁用 | 去掉阴影，留 1px `hairline` 轮廓，面不变 | `ink-faint` | `dur-state` | 不整体降透明度（会把柔影变灰） |
| 加载 | 不变，宽度锁定 | 图标槽换成同尺寸转圈；文字不变或换成进行时（「核对中」） | 转圈 `dur-loop` | 按钮在加载中不可再次触发 |
| 错误 | 不变 | 下方 `danger` 文字 + `error` 图标；输入框保持凹陷 | `dur-state` | 不用红色描边、不抖动 |

### 反馈槽

- 复制：复制图标与勾号共用一个槽，双向交叉缩放（`dur-state` `ease-emphasized`），勾号停 `hold-copy` 后回到复制图标；读屏同步改为「已复制」。
- 发送状态：用户消息下方原本放复制 / 回退的位置，换成「发送中 / 已排队 / 未确认是否送达 / 失败原因」+ `disc-xs` 操作，不在聊天里插新行。
- 正在工作（运行中、同步、重连）：实心点缩到 6，外面一道 1.5px 的弧绕着转（`dur-loop` `ease-linear`），尾部渐隐；颜色、文字、宽度都不变。只在真的有事在发生时出现——连接正常时是静止的实心点。减少动画时弧停住不转。
- 滑动关闭：卡片跟手，进度环随距离填满；到卡片宽度 40% 时上膛——凹座浮起、图标与文字转 `danger`、文字换成「松手关闭」，并给一次触觉；只有上膛状态松手才关闭，否则弹回（见 SessionCard）。
- 刷新：顶栏或下拉刷新只改指示器，不插入"正在刷新"行，阅读位置不动（V05 / V03）。

### 触觉

只给"有分量的确认"：发送、应用配置、切换根标签、多选开始与每次选择变化、删除确认。普通按钮、滚动、展开不震动。iOS 用 `OrbisHaptics.commit()` / `selectionChanged()`，Android 用 `rememberActionHaptic()`，两端同一清单。

### 文案在状态里的位置

- 进行时写在原位：「切换」→「切换中」，按钮宽度按较长的一个预留。
- 失败说原因和下一步：「Codex 拒绝切换：当前会话仍在运行」+「核对」。
- 不确定的结果不假装成功：「未确认是否送达」而不是「已发送」（ADR-0049）。

### 防误操作

- **两个手势不共用一块地方。** 同一控件里有两层可拖的东西（供应商圆盘的 Agent 带与配置盘）时，两层之间留至少 24px 的"护城河"：画成一道同色凹槽，从这里开始的触摸什么都不做。按下即按区域锁定拖哪一层，整个手势不换；按下的瞬间另一层退到 `opacity-dim`。
- **重的那层更难动。** 影响范围大的一层（换 Agent）起拨阈值更大、带吸附、松手无惯性；轻的一层（换配置）按速度吸附。
- **浏览不等于应用。** 拨动、点选、滑动只改变"正在看什么"；会改变运行状态的动作一律另按按钮，按钮写清后果，还在动画中时禁用。
- **破坏性手势要过门槛。** 左滑关闭以 40% 宽度为门槛，过门槛前有可见的进度，过门槛时状态明显翻转。

### 设置页

- 能有默认答案的就不做开关：回复完成一律通知，不给"回复完成时通知"的选项；配对的电脑在连接卡片里，不单独做"电脑"页。
- 设置行显示“连接协议”，当前协议值放在右侧；详细选择进入底部面板，候选项简短呈现并提供应用按钮。
- 看得见的选择用看得见的控件：外观用 `AppearancePicker`（缩略屏 + 跟随系统选项 + 材质色块），不用文字分段。
- 选中统一是"按下去"+ `accent` 文字，不加描边。

### 新建会话

- 首页列表顶上开出一道槽，草稿卡片从材料里升起（凹陷 → 平 → 凸起），在卡片里选 Agent、目录，可直接启动或写第一句话；提交后卡片长成会话页，草稿在底下换成真会话卡。详见 `SessionDraft`。
- 新出现的东西都"从材料里升起"，消失的东西都"按回材料里"：开槽 / 合槽用 `dur-collapse`，深度变形用 `dur-selection`，内容晚 120ms 淡入。不用缩放弹出。
- 一个元素长成一整页时用形状过渡：页面从元素的矩形与圆角展开到全屏（`dur-page` `ease-page`）；返回仍是普通的推回。

## 9 动效

动效回答一个问题：**刚才那个东西去哪了。** 每次变化都是已有元素的连续变形；同一种变化全 App 只有一种做法；时长和曲线只能取 `dur-*` / `ease-*`。

### 词汇

| 角色 | 时长 | 曲线 | 例 |
| --- | --- | --- | --- |
| 按下 / 松开 | `dur-press` 80 / `dur-release` 160 | `ease-emphasized` | 所有按钮、圆钮、卡片、菜单项 |
| 小状态 | `dur-state` 160 | `ease-out` | 焦点柔光、勾选、复制 ↔ 勾号、启用 ↔ 禁用 |
| 出现 | `dur-panel` 220 | `ease-out` | 菜单、对话框、底部面板、短反馈、外观切换 |
| 选择交接 | `dur-selection` 260 | `ease-emphasized` | 标签、分段的深度交接；批量选择扩散 |
| 尺寸变化 | `dur-collapse` 260 | `ease-standard` | 折叠、列表插入 / 移除、工具组分页 |
| 离开 | `dur-exit` 160 / `dur-dismiss` 180 | `ease-in` | 菜单、短反馈离开；返回键关闭页面 |
| 淡入淡出交接 | `dur-fade-out` 90 + `dur-fade-in` 210 | `ease-in` + `ease-out` | 根标签切换、离散文字替换 |
| 流式内容 | `dur-reply-grow` 180 | `ease-emphasized` | 回复卡增高；首次出现 `dur-panel` |
| 跟手 | 弹簧 | spring-drag k1200 c80（过阻尼）/ spring-page k260 c24 / spring-pop k380 c18 | 拖拽回位、整页右滑、勾选弹跳 |
| 循环 | `dur-loop` 1100 | `ease-linear` | 不确定进度、骨架高光、状态点外的绕行弧 |
| 升起 / 按回 | `dur-collapse` 260 + `dur-selection` 260 | `ease-standard` + `ease-emphasized` | 新建会话的草稿卡片：开槽、凹陷 → 凸起；收起时反向 |
| 形状过渡 | `dur-page` 320 | `ease-page` | 一个元素长成整页（草稿卡片 → 会话页） |

弹簧是原生实现的正解；网页与 Host 用 `ease-page` / `ease-pop` 近似。

### 编排：每一种交互和画面切换

#### 按压（全部可点元素）——新增"深度过渡"

现状只有字形缩放，表面从凸起瞬间跳到凹陷。改为：

- 表面在 `dur-press` 内连续经过 凸起 → 平 → 凹陷；松开在 `dur-release` 内反向。
- 原生实现：把 `NeumorphStyle` 换成一个可动画的 `depth: Float`（+1 凸起，0 平，−1 凹陷）。外阴影 alpha = `max(depth, 0)`，内阴影 alpha = `max(−depth, 0)`，两组都从已有的柔影缓存里取，**不新增图层**。Compose：`animateFloatAsState(target, tween(InteractionMotion.duration(if (pressed) GlyphPress else GlyphRelease), easing = GlyphEase))`；SwiftUI：`intensity` 与 `inset` 合成一个 `depth`，用 `InteractionMotion.glyphPress / glyphRelease` 驱动。
- 网页 / Host：凸起与凹陷写成同一组四段阴影（外两段 + 内两段，另一组为透明），浏览器即可插值；`bundle.css` 的 `.ob-surface` 即为参考实现。
- 字形同时缩到 `scale-press`、`opacity-glyph-pressed`（M11 / M20 原值）。
- 列表里的卡片用 `immediatePressFeedback`：滚动开始时立刻取消下沉。

#### 选择（标签、分段、单选列表、外观缩略屏与色块、草稿里的 Agent）——新增"深度交接"

新选中项在 `dur-selection` 内下沉、旧选中项同时浮起，文字颜色 `dur-state` 换为 `accent`；标签图标在描线与实心之间交叉淡化。不使用滑动色块，不加描边。

#### 根标签切换（聊天 / 供应商 / 设置）——新增

现状硬切。改为 fade-through：旧内容 `dur-fade-out` `ease-in` 淡出；新内容在其后 `dur-fade-in` `ease-out` 淡入并从下方 8px 升起。按标签顺序不做左右位移（平级、不是前进后退）。各根页面的滚动位置与状态保留（`rememberSaveableStateHolder`，现有）。触觉：一次选择反馈。

#### 整页推入与返回（M14 / M08 / SC28）

- 推入：新页从右侧进入，弹簧 spring-page；下层页同时左移 24 并加 `scrim` 至 `opacity-scrim`（SwipeBack.kt 现值 0.34）。
- 右滑返回：全程跟手，松手按速度投射决定完成或回弹（同一弹簧）；边缘返回时页面轻微压缩（现值保留）。
- 返回键 / 返回圆钮：`dur-dismiss` `ease-in`。
- 网页 / Host 的桌面导航：内容区 `dur-page` `ease-page` 横移 24 + 淡入，不做整屏滑动。

#### 抽屉（M09）

跟手打开；松手 spring-drag 回位；关闭 `dur-dismiss`。抽屉下的主页面不缩放，只加 `scrim`。

#### 锚点菜单与菜单栈（M18）

从锚点所在角展开：`scale-enter` → 1 + 淡入，`dur-panel` `ease-out`；离开反向 `dur-exit` `ease-in`。子菜单在同一外框内交叉淡化并以自然高度调整外框（`dur-collapse`）。

#### 对话框与底部面板——统一

- 对话框：`scrim` 淡入 `dur-panel`；面板 `scale-enter` → 1 + 淡入，中心为原点。离开 `dur-exit`。
- 底部面板：从下方 24 升起 + 淡入 `dur-panel`；拖拽把手跟手，松手 spring-drag；关闭向下 `dur-dismiss`。替换 Material `ModalBottomSheet` 的默认外观与时长（形状、把手、阴影按 `Sheet`）。

#### 短反馈（V06 / SC34）

从所在边缘 12px 外升起 + 淡入 `dur-panel`；停 `hold-toast`；离开淡出 `dur-exit`。覆盖在内容之上，不推开任何布局；带操作或错误的反馈不自动消失。

#### 折叠（M03）

自然高度 0 ↔ 1，`dur-collapse` `ease-standard`；首次展开才构建内容，之后保留身份（ADR-0048）；箭头同步旋转。网页用 `grid-template-rows: 0fr → 1fr`。

#### 列表插入与移除——统一

- 插入：高度从 0 展开 `dur-collapse`，内容在后半段 `dur-state` 淡入。
- 移除（首页左滑关闭 SC01、批量关闭 SC02）：内容淡出 `dur-state`，随后高度收起 `dur-collapse`，下面的卡片自然上移；乐观关闭可恢复（V11）。
- 替换首页关闭指示当前私有的 90 / 100 / 140 时长。

#### 左滑关闭（SC01）——门槛与上膛

- 卡片跟手左移，下面的同色凹槽里，右侧 `disc-xs` 凹座外有一圈 2px 进度环，随距离填满。
- 到卡片宽度 40% 时上膛：凹座浮起成 `raised-sm` 并轻弹到 1.12（`dur-selection` `ease-pop`），图标、进度环、文字在 `dur-state` 内转为 `danger`，文字换成「松手关闭」，同时一次触觉。
- 过门槛后继续拖有 0.4 倍阻力；拖回门槛内立即解除。只有上膛状态松手才关闭（再走上面的"移除"），否则 spring-drag 弹回——不按速度猜意图。

#### 新建会话——升起、书写、长成整页

1. 开槽：顶栏 + 在 `dur-selection` 内转 45° 成 ×；列表顶上以自然高度展开一道槽（`dur-collapse` `ease-standard`），此时草稿卡片是凹陷。
2. 升起：约 200ms 后同一块材料由凹陷经平面推成凸起（`--ob-down` → `--ob-rest`，`dur-selection` `ease-emphasized`），内容晚 120ms 上浮 4px 淡入（`dur-state`），输入槽获得焦点；其余卡片退到 `opacity-dim`。
3. 长成整页：点击启动或发出第一句话时，会话页以 `clip-path` 从草稿卡片的矩形与圆角展开到全屏（`dur-page` `ease-page`），有首句时随即作为第一条用户消息飞入（`dur-send`）；页面盖住列表后，草稿在下面换成真正的会话卡。
4. 按回：收起时内容先淡出、卡片按回凹陷（`dur-selection`），再合上槽（`dur-collapse`）。

#### 状态点：正在工作

只在真的有事在发生（运行中、同步、重连）时出现：实心点缩到 6，外圈一道 1.5px、尾部渐隐的弧绕行，一圈 `dur-loop` `ease-linear`。颜色、文字、宽度不变。不做呼吸、不发光。

#### 聊天

- 发送（M17 / SC14）：输入内容飞入消息位置 `dur-send`（280 飞行 + 160 展开），终点是用户消息的凹槽。
- 回复首现与增高（M24 / SC47）：首次 `dur-panel` 淡入上浮；流式增高 `dur-reply-grow`；新增字形逐个渐显（M04）。
- 回到最新（SC18）：按钮淡入 `dur-state`；点击用原生平滑滚动，阅读锚点规则不变（ADR-0046 §1）。
- 工具组展开与分页（MOT-27）：折叠动效 + 新页工具按插入规则出现。

#### 外观切换——新增

浅 / 深或雾蓝 / 灰绿切换时（设置里的 `AppearancePicker`），底板、墨色和阴影颜色同时交叉淡化 `dur-panel` `ease-out`；不重排、不闪白。Android 在 `OrbisTheme` 外层用 `animateColorAsState` 驱动材质色；iOS 用 `.animation(.easeOut(duration: 0.22), value: scheme)`；网页过渡 `background-color` / `color`。

#### 加载——新增骨架

首帧优先显示缓存（V13）；只有真正没有数据时显示骨架：同色的 `inset-sm` 凹槽线条（`opacity-skeleton`），一道 `highlight` 高光以 `dur-loop` 线性扫过。数据到达时骨架淡出 `dur-state`、内容淡入，行高预先一致，不跳动。不确定进度条用同一 `dur-loop`；确定进度条宽度 `dur-state` 过渡（替代 Host 的 200 线性）。

#### 数字与离散文字（M21 / M22）

计数、配额百分比、状态词变化用 fade-through（90 + 210）；数字可按位滚动（Host `MotionText roll` 已有，移动端同步）。等宽数字保证宽度不变。

#### 下拉刷新（M15）

沿用平台手势与现有弹簧（Android damping 0.9、stiffness 520 / 420；iOS 一次原生回位），刷新完成不插入提示行。

#### 供应商圆盘（S32）

- 两个操作区：左侧 Agent 带只换 Agent，右侧配置盘只换配置，中间 24px 的同色凹槽不响应。按下即按区域锁定，另一层在 `dur-state` 内退到 `opacity-dim`，握住的 Agent 带浮起到 `raised-md`。
- 配置盘：跟手转动；松手按速度投射到最近刻度，三次缓出落定，时长随距离 220–460ms；每越过一格，盘缘指示点轻跳一次（`dur-state` `ease-emphasized`，放大 1.5 倍），原生同时给一次选择触觉。两端阻尼回弹（0.3 倍），不循环。
- Agent 带：起拨阈值 10px（配置盘 4px），每个 Agent 需拖 84px，刻度带吸附（停在附近会粘住、过中点才让开），松手不惯性滑行；换 Agent 时圆窗轻跳（放大 1.08），配置名整体淡入（`dur-state`），配置盘跳回该 Agent 正在用的配置。
- 任一层还在拖动或回弹时，页面的主按钮禁用。
- 配额：两窗口（5 小时 / 7 天）随浏览项替换时数字做 fade-through；不再需要翻面查看。

### 减少动画

系统"减少动态效果"打开时：所有位移、缩放、弹簧直接到终态（开槽、升起、长成整页都直接切换）；保留 ≤`dur-state` 的颜色 / 不透明度交叉淡化（让状态变化仍可察觉）；循环停止（状态点的绕行弧停住、骨架静止）。Android 用 `InteractionMotion.duration()`（`areAnimatorsEnabled`），iOS 用 `orbisReduceMotion`，网页用 `prefers-reduced-motion`。

### 不要

- 不要在单个页面里写新的时长或弹簧常量；需要新角色时先加 token。
- 不要用 `Modifier.blur` / `graphicsLayer` 给柔影做动画（会裁切和丢帧，见 `Neumorph.kt`）。
- 不要让动画改变阅读位置、消息身份或命中区（V01–V09）。
- 不要为了"有动效"给静态内容加入场动画；首屏和缓存内容直接显示。

## 10 布局与页面

### 导航模型

```
根（平级，不压栈）           推入（整页，右滑返回）          叠加（不离开当前页）
┌ 聊天 ─┬ 供应商 ─┬ 设置 ┐   会话 / 下载 / 电脑管理       锚点菜单（行操作）
│ 首页   │ 圆盘     │ 分组  │   历史与分支 / 文件浏览       对话框（确认、不可撤销）
└───────┴────────┴─────┘   添加电脑                        底部面板（选择：模型、权限、目录、连接协议）
          ↑ 左侧抽屉：工作目录与会话目录                       短反馈（结果）
  列表内：新建会话的草稿卡片（从首页列表里升起，发出后长成会话页）
```

- 根标签只在根页面显示；推入页面不显示标签栏。聊天、供应商和设置是平级根页面；系统返回离开应用，应用内的“返回聊天”入口切换到聊天页。
- 一个任务一种容器：需要确认 → 对话框；需要从一组里挑 → 底部面板；对某一行操作 → 锚点菜单；告知结果 → 短反馈；需要完整阅读或多步操作 → 推入整页。不要用对话框承载列表，不要用整页承载一次确认。
- 新建、工具、文件入口位置固定（S20）：首页顶栏右侧下载 + 新建（+，草稿打开时转为 ×）；会话顶栏右侧历史 + 下载；附件在输入栏左侧。侧栏每个展开的目录末尾有「+ 新建会话」，带着那个目录打开草稿。

### 页面骨架（手机）

```
状态栏（系统，底色 surface-base）
顶栏 bar-height 56：左侧返回 / 目录（disc-md）；标题 title（可带一行 label 副标题）；右侧最多 2 个 disc-md
内容：左右 space-20，分区间 space-24，卡片间 space-12
[根页面] 标签栏 bar-height 56 + 上 space-8 / 下 space-12，三项等宽、间隔 space-12
[会话页] 输入栏：路径、分支、权限使用独立信息槽；附件 disc-md；输入凹槽 field-height；发送 / 停止 disc-md
导航栏（系统，底色 surface-base）
```

- 顶栏、标签栏、输入栏与页面同底色，不加分隔线；内容滚动到下方时也不改底色。
- 系统栏颜色由唯一的窗口持有者设为 `surface-base`（`OrbisSystemBars`），推入页和抽屉不另行设置——这也消除深色首页底部的色带。
- 键盘出现时输入栏随键盘上移，内容保持阅读锚点（V08）。

### 首页

- 顶栏：目录圆钮、`Wordmark`（Orbis + Easy Agents Everywhere）、下载、新建。
- 电脑行：电脑名（`body-strong`）+ 连接胶囊（`StatusPill`：静止实心点 + 局域网 / 中继 + 锁；只在同步或重连时出现绕行弧）。多台电脑时电脑名可点切换（SC06）。
- 新建会话：点 + 时列表最上方升起 `SessionDraft`，其余卡片退到 `opacity-dim`。
- 会话卡列表：`SessionCard`，Agent 标记槽 44；标题固定两行，路径、模型、状态各一行，模型为空时显示 Agent 名称，状态为空时保留行槽。长按进入多选，左滑到 40% 上膛关闭。列表下方提示“长按卡片多选，向左滑动关闭”。

### 会话

- 顶栏：返回、标题与副标题（Agent 标记与名称、状态、模型）、历史与分支。整页处于该 Agent 的作用域，不提供下载管理按钮。
- 消息流最大宽度 `reading-width`；用户消息靠右、最宽 85%；助手内容每个可见步骤一张卡（ADR-0066），卡片间 `space-16`。
- 回到最新：右下角 `disc-md`，距输入栏 `space-12`。

### 设置

- 分组：分区标题（`label` `ink-muted`）+ 一张 `ListGroup` 卡；行高 `control-height`；行内值用 `StatusPill` 或 `ink-muted` 文字；行尾操作用 `RowAction`（图标 + 13 号 `accent` 文字）。
- 只有三组：
  - **连接**：电脑名与连接方式分别布局，`StatusPill` 显示已连接或连接中；连接协议行右侧显示当前协议类型，选择后通过底部面板应用。仅在必须说明网络限制时使用 info 图标展开提示。
  - **外观**：`AppearancePicker`——浅色 / 深色缩略屏、跟随系统单选项、雾蓝 / 灰绿色块。
  - **语言**：当前语言 ›，选项为跟随手机、简体中文、English。
- 不再有：「回复完成时通知」开关（默认通知）、单独的「电脑」分组。

### 供应商（转盘）

- 顶部一行：电脑名、Agent 名称和配置数量分别呈现（例如“Codex，电脑上保存的 4 个配置”）。Pi 可同时启用多个配置。不再有 Agent 分段；换 Agent 在圆盘的 Agent 带上完成。
- 中间：`ProviderDial`（双层、`zoom` 1.6），占满剩余高度（至少 300）。
- 下方：配额两栏（5 小时 / 7 天，或“这个配置不提供配额查询”，高度固定 112）→ 主按钮（“切换到 relay-b” / 禁用的“正在使用 本机配置” / Pi 的“启用 / 移出”）。当前位置与配置总数单独显示，不出现操作说明句。
- 切换需对话框确认：「切换 Codex 到 relay-b？」，正文说明正在运行的会话继续用原配置。
- 去掉英文大写标题、等宽字间距标签和 `✓` `↗` 字符；状态用 `StatusPill` 与 `check` / `swap_horiz` 图标。

### 抽屉

宽 `drawer-width`（手机上最多 85% 屏宽），内边距 `space-16`，是导航面（单行、13 号、无卡片）：搜索槽（`radius-sm`）+ 筛选圆钮 →“工作目录 3”（`label` `ink-muted` + `caption` 计数）→ `DirectoryGroup` 列表（目录行 48，展开为带 `hairline` 引导线的会话树）→ 底部一行电脑信息，按电脑名、连接类型和状态点分别布局；上方一条 `hairline`。

### 平板与桌面

| 宽度 | 布局 |
| --- | --- |
| < 600 | 手机：单栏，抽屉覆盖 |
| 600 – 959 | 平板：目录常驻左栏 `drawer-width`，右侧内容 `reading-width` 居中；根标签移到左栏底部 |
| ≥ 960（Host、官网） | 左侧导航 `host-sidebar`；内容区边距 `space-40`，最大宽度 880；分区 `space-48` |

Host 导航项：图标（Material Symbols）+ `body` 文字，选中凹陷 + `accent`；页面标题 `display`；卡片、按钮、开关、输入沿用同一套组件规格（圆角从 6–8 改为 16 / 24）。指针设备启用悬停态与 `focus-ring`。

### 层级

`z-bar` 10 顶栏 / 标签栏，`z-drawer` 20 抽屉与推入页，`z-menu` 30 菜单，`z-scrim` 40 遮罩，`z-modal` 50 对话框 / 底部面板，`z-toast` 60 短反馈。短反馈不拦截自身范围外的触摸。

### 扩展新功能时

1. 先选容器（上面的"一个任务一种容器"），再选组件；没有合适组件时组合现有组件，不新造外观。
2. 新页面用页面骨架；新卡片用 `Surface` + 同心圆角；新状态先查「交互状态」。
3. 新颜色需求先归主人（Orbis / Agent / 状态）；新 Agent 加一个 `agent-*` token，选一个与现有四个色相差 ≥45° 的色并验证 4.5:1。
4. 新动效先在「动效」里找到同角色的编排；确实是新角色时，先加 `dur-*` / `ease-*` token，再写代码。

## 11 组件

组件是原生实现的规格样张：Compose 里对应 `NeumorphSurface` 一族，SwiftUI 里对应 `neuSurface` 一族，Host 对应 `NeuSurface` 一族；网页参考实现在设计系统的 `components/bundle.js` / `bundle.css`（`window.Orbis`）。名称对照见「落地映射」。

### 11.1 基础

#### Surface

所有 Orbis 内容块共用的材质：能按、独立成块时凸起，承载输入或选择时凹陷。

- 属性：`depth` `'raised' | 'inset'`（默认凸起）；`size` `'sm' | 'md' | 'lg'`（对应 `raised-sm / -md / -lg`）；`pad`（加 `space-16` 内边距）；`onClick`（变为可按）；`as`、`className`、`style`、`children`。
- 只有最外层投外阴影。表面里可以随意再放表面：凸起的自动变成平的明度台阶（`surface-lift`，再深一层 `surface-top`）；凹陷的保留内阴影，底色等于所在表面的面。
- 凹陷从不换底色：深度只来自内阴影。
- 可按的表面按下时走深度过渡：`dur-press` 内凸起 → 平 → 凹陷，`dur-release` 内复原。
- 圆角：卡片 `radius-lg`；内缩 `space-12` 的嵌套面板用 `radius-sm`。
- 不要给静态标签做凹槽，不要让输入框凸起，不要用描边做分隔。
- 原生：Compose `NeumorphSurface(style, shadowScale)`，SwiftUI `.neuSurface(inset:radius:intensity:padding:)`；shadowScale 只取 0.4 / 0.65 / 1.0。

#### Icon

Material Symbols Rounded 描线图标，四种尺寸，颜色跟随所在文字。

- 属性：`name`（Material Symbols 名称，如 `history`、`swap_horiz`）；`size` `'md'` 22，`'sm'` 18，`'xs'` 16，`'inline'` 14；`fill`（实心：选中的根标签、`stop`、`check_circle`、目录槽）；`text`（下移 0.125em 贴齐文字基线）；`label`（只在图标独立表达含义时提供）。
- 颜色是 `currentColor`：默认 `ink`，次要 `ink-muted`，动作用页面强调色，停止与删除用 `danger`。
- iOS 用「落地映射」对照表里的 SF Symbols；Host 与官网用 Icons 资产组里的 SVG。
- 不用 Unicode 字符或 emoji（◈ ⚙ ✓ ↗ ⠿）代替图标。

#### AgentLabel

Agent 的身份：标记、用自身颜色写的名称，以及可选的实时状态。

- `AgentLabel` 属性：`agent` `'pi' | 'codex' | 'deepseek' | 'claude'`；`status`（状态词）；`statusTone` `'idle' | 'success' | 'warning' | 'danger'`；`syncing`；`mark`（false 隐藏标记）；`name`（覆盖名称，如「Codex 桌面版」）。
- `AgentEmblem`：44 的凹陷识别槽（`disc-lg`、`radius-md`、`inset-sm`），标记 24。只用于识别，从不作为按钮。
- `AgentScope`（或在容器上加 `ob-agent-scope ob-agent--<agent>`）：其中的 `accent` 与 `focus-ring` 变成该 Agent 的颜色。整个会话页包在里面。
- Agent 色只给名称、标记和会话内的操作；状态色留在状态点和状态词上。
- Pi 与 Claude 标记保留自身配色；Codex 与 DeepSeek 是单色标记，用 `agent-codex` / `agent-deepseek` 着色。

#### Wordmark

凹刻的 Orbis 字标与 Slogan，只在首页顶栏出现一次。

- 属性：`tagline`（字符串，或 `false` 隐藏；默认 "Easy Agents Everywhere"）。
- 名称为 `title`、`ink`，加 `engrave` 文字阴影（暗壁左上、亮壁右下，浮雕 1.8）；语义上只有一个文字节点，两层墙只是装饰。
- Slogan 用 `label`、`ink-muted`，不着色。拼写为 "Easy Agents Everywhere"。
- 原生：Android `OrbisWordmark` 与 Host 的三层字标已是此画法，浮雕保持 1.8dp/pt。

#### StatusDot

状态点：状态词旁边的一个小记号。它是墨，不是材质——没有阴影、没有光泽、不发光、不呼吸。

- 属性：`tone` `'idle' | 'success' | 'warning' | 'danger' | 'accent'`；`syncing`。
- 占位 `dot-ring` 16，点 `dot` 8。
- 空闲（`idle`）：1.5px 的空心圈（`ink-faint`）——"什么都没在发生"，不靠颜色也能和其他状态分开。
- 有状态：同色实心点（`success` / `warning` / `danger` / `accent`）。
- `syncing`（运行中、后台同步、重新连接）：实心点缩到 6，外圈一道 1.5px 的弧绕着转，弧的尾部渐隐，一圈 `dur-loop`、`ease-linear`。这就是"正在进行"的通用形状，缩小到能放在一个词旁边。颜色、文字、宽度都不变；减少动画时弧停住。
- 只在真的有事在发生时用 `syncing`：连接正常就是静止的实心点，不要让首页顶部一直转。
- 永远和状态词一起出现，点本身不单独承载含义。
- 原生：`NeumorphStatusDot` 去掉凸起与高光，改为 Canvas 画实心圆 / 空心圈；工作中用 `drawArc` + `sweepGradient`（iOS `Circle().trim` + `AngularGradient`）旋转，周期 1100ms 线性。

### 11.2 操作

#### Button

凸起的文字操作：默认次要；`primary` 给本页最主要的事；`danger` 给破坏性操作；`link` 是扁平的导航文字。

- 属性：`variant` `'secondary' | 'primary' | 'danger' | 'link'`；`size` `'md'` 48，`'sm'` 40，`'block'` 整宽 56；`icon`（前置图标名）；`loading`；`selected`；`disabled`；`onClick`；`children`（2–4 字动词：切换、应用、重新发送）。
- 主按钮不是彩色色块：同样的凸起表面，文字用 `accent`（会话内为 Agent 色）。一页最多一个。
- 危险按钮用 `danger` 文字；确认对话框要写明对象（「取消配对 workstation？」）。
- 链接（`variant="link"`）是扁平 `accent` 文字 + 尾部箭头，用于「查看全部 11 个工作目录 ›」，不用于提交。
- 状态：按下 = 深度过渡 + 字形 `scale-press`；加载时图标槽换成同尺寸转圈、宽度不变；禁用 = 无阴影 + `hairline` 轮廓 + `ink-faint` 文字（不整体降透明度）。
- 在对话框、底部面板和卡片里，按钮是平的明度台阶（`surface-lift`），按下回到父表面的面并出现内阴影。
- 原生：把 Android `NeumorphTextButton` / `NeumorphActionButton` 与 iOS `OrbisTextButton` 合并为同一规格——中号 48 / 15 半粗 / 图标 18 / 间距 8 / 左右 20 / `radius-md`；小号 40 / 13 半粗 / 图标 16 / 间距 6 / 左右 16 / `radius-sm`。

#### IconButton

只有图标的操作：凸起的圆钮，居中于 48 的命中区。

- 属性：`icon`；`label`（必填，读屏名称，如“历史与分支”）；`size` `'md'` 40，`'sm'` 36，`'xs'` 28；`tone` `'ink' | 'accent' | 'danger'`；`fill`；`pressed`（开关态：凹陷 + 强调色）；`copy`（复制 ↔ 勾号反馈，固定槽位）；`disabled`；`onClick`。
- md 用于顶栏与输入栏，sm 用于卡片旁、行内的次要操作，xs 只用于待确认消息下的密集操作。
- 图标尺寸随圆钮：22 / 18 / 16。命中区永远是 48，相邻圆钮不再额外留间隙。
- `tone="accent"` 给发送、附件（会话内为 Agent 色），`tone="danger"` 给停止。
- 开关态（`pressed`）保持凹陷、图标变强调色，例如已开启的筛选。
- 原生：`NeumorphIconButton` / `OrbisIconButton`；iOS 最小命中区从 44 提到 48。

### 11.3 输入与选择

#### TextField

凹陷的文字输入框，标签在凹槽上方，说明或错误在下方。

- 属性：`label`；`placeholder`（`ink-muted`，可读）；`value` / `defaultValue` / `onChange`；`help`；`error`（替换说明，`danger` + 错误图标）；`search`（前置搜索图标，高 48）；`icon`；`trailing`；`multiline`；`disabled`。
- 凹槽：底色同所在表面 + `inset-md`、`radius-md`、高 56（`field-height`）、左右 `space-16`。
- 聚焦时加两圈 `focus-halo`（页面强调色），不改尺寸，`dur-state`。聚焦和出错都不加彩色描边。
- 标签和说明放在凹槽外，内阴影不会穿过它们。
- 原生：Android `NeumorphTextField` + `neumorphFieldColors()`，iOS `.orbisInput(focused:)`。

#### Checkbox

24px 的凸起方块，勾选后下沉并出现强调色对勾；同族的 `SelectionIndicator` 用于批量选择。

- `Checkbox` 属性：`checked` / `defaultChecked`、`onChange`、`label`、`disabled`。48 命中区包含标签。
- 勾选：凹陷 + 强调色对勾，以 `ease-pop`（原生为 spring-pop）弹入。
- `SelectionIndicator` 属性：`selected`、`visible`。24 圆：未选为 `ink-faint` 圆环，选中为 `accent` 填充 + `on-accent` 对勾。非多选时也保留槽位（`visible={false}`），卡片不重排。
- 选项类设置用 Checkbox；只有多选模式下的卡片和行用 SelectionIndicator。
- 原生：`NeumorphCheckbox` / `OrbisCheckbox`；两端 `OrbisSelectionIndicator`（iOS 由 22 改为 24）。

#### Switch

即时生效的开关：凹陷槽 + 凸起圆角方块滑块，并显示「开 / 关」文字。

- 属性：`label`、`sub`（一行说明）、`row`（设置行布局：文字在左、开关在右、不显示「开 / 关」）、`checked` / `defaultChecked`、`onChange`、`disabled`、`onText` / `offText`。
- 槽 56×32、`radius-sm`、`inset-sm`；滑块 24、`radius-xs`、`raised-sm`，以 `dur-selection` `ease-emphasized` 滑动 24；开启时滑块上的指示点变为 `accent`。
- 只用于立即生效的二态设置（Host 的开机启动）。需要确认或会打断连接的改动用 `ChoiceList` + 应用按钮。能有默认答案的就不做开关（回复完成一律通知）。「跟随系统」使用 `AppearancePicker` 的整行单选项。
- 来源：Host 的柔软开关；移动端按此规格实现。

#### Segmented

一排凸起选项，只能选一个；选中的那个被按进底板。

- 属性：`options` `[{ value, label }]`（2–4 个）、`value` / `defaultValue`、`onChange`、`label`（组的读屏名称）。
- 每项高 48、`radius-md`、间隔 `space-8`、`raised-sm`。选中项凹陷，`accent` 600 文字；切换时做深度交接（`dur-selection`）：新项下沉、旧项同时浮起。
- 用于 2–4 个一看就懂的同级选项（如思考强度）。需要解释的选项（连接协议、权限）用 `ChoiceList`；外观用 `AppearancePicker`；Agent 用 `SessionDraft` 的标记行或供应商圆盘。超过四项改用底部面板列表。
- 取代转盘页"在凹槽里凸起"的选中写法：选中永远是凹陷。
- 原生：`AgentChoice` 与协议模式按钮组。

#### ChoiceList

单选列表用于连接协议、下一轮权限等需要明确应用的设置。选项标题直白简短；默认不添加解释性小字。只有存在必须提前说明的非显然后果时，才用 info 图标按需展开。

- 属性：`options` `[{ value, title, sub?, tag }]`；`value`；`onChange(value)`；`label`（读屏名称）。`sub` 仅用于确实需要常驻说明的场景。
- 每行：24 的单选凹座 + 标题（`body-strong`），可带一个 `caption` 小标签，如“推荐”（`ink-muted`，不上色），或 info 图标。
- 选中的整行按下去成 `inset-sm`，单选点亮，标题 `accent`。行高至少 48，整行可点。
- 放在底部面板里，配一个主按钮把选择“应用”出去；按钮直接写清后果，例如“切换到 WebSocket 并重连”，与当前相同时禁用并显示“当前使用”。会打断当前连接或任务的设置，一律不在点选时立即生效。
- 设置页的“连接协议”行只显示当前协议值，点进去才是 ChoiceList。
- 不要：用 `WS` `QUIC` 这样的缩写当分段标签；让用户在没有说明的情况下选技术选项。

#### AppearancePicker

设置页的外观选择：看着选，而不是读字选。两张缩略屏选浅色 / 深色，一个独立选项决定是否跟随系统，两颗色块选材质。

- 属性：`material` `'mist' | 'sage'`；`mode` `'system' | 'light' | 'dark'`；`systemDark`（系统当前是否深色）；`onMaterial(v)`；`onMode(v)`。
- 缩略屏（`ThemePreview`）：用目标主题自己的 token 画一屏小样——顶栏、两张凸起卡片（一张亮着状态点）、底部输入槽和发送点。颜色不写死，token 改了缩略屏跟着变。
- 浅色 / 深色：两张缩略屏并排，`raised-sm` 外框；选中的外框按下去成 `inset-sm`，下面的单选点亮、文字 `accent` + 600。点任一张即明确指定，并关掉跟随系统。
- 跟随系统：独立的整行单选项。未选时凸起，选中时凹陷并显示勾号；不加解释性副标题。选中时缩略屏随系统变。
- 材质：右侧两颗 28 的色块，各用该材质（在当前浅 / 深下）的底色与主色画成一颗凸起小钮；选中的外圈按下去成凹座，名字 `accent` + 600。
- 选中一律是"按下去"，不加描边（S05）。切换时整页用主题交叉淡化（`dur-state`），减少动画时直接替换。
- 不要：用分段控件写“雾蓝 / 灰绿”或“跟随系统 / 浅色 / 深色”；把三种模式并排成三个同级选项。

### 11.4 导航

#### TopBar

每个页面顶部 56 高的栏：左侧一个圆钮，标题（可带一行副标题），右侧最多两个圆钮。

- 属性：`title` 或 `titleNode`（首页放 `Wordmark`）；`subtitle`（一行 `label`：Agent、状态、模型）；`back` / `onBack`（返回圆钮）；`leading`（如目录圆钮）；`actions`（≤2 个 `IconButton`）；`agent`（会话页把强调色交给该 Agent）。
- 与页面同底色（`surface-base`），无分隔线，滚动时不改变。
- 标题 `title` 20/600，单行省略；副标题不换行。
- 原生：`RemoteTopAppBar` 与会话顶栏。

#### TabBar

三个平级根页面——聊天、供应商、设置——的底部栏，当前页按进底板。

- 属性：`tabs` `[{ key, label, icon }]`、`value` / `defaultValue`、`onChange`、`label`。
- 三项等宽、间隔 `space-12`，高 56、`radius-md`、`raised-sm`。选中：凹陷、`accent` 600 文字、实心图标；其余描线图标 `ink-muted`。
- 切换：标签做深度交接（`dur-selection`），内容做 fade-through（`dur-fade-out` 90 + `dur-fade-in` 210，上浮 8px）。各根页面保留滚动与状态。
- 只在根页面显示。应用内的“返回聊天”入口切换标签；系统返回按根页面行为离开应用。
- 原生：`HomeTabBar`（Android 圆角 19 → 16、高 58 → 56、图标 21 → 22）。

#### Menu

锚定在圆钮或长按位置的操作菜单，作用于一行或一张卡。

- `Menu` 属性：`items`——每项 `{ label, icon, hint, danger, onSelect, disabled }`，或用 `'-'` 分组；`origin`（展开的角，如 `'top right'`）；`leaving`。
- 容器：`raised-lg`、`radius-lg`、内边距 `space-8`、宽 220–300。菜单项：高 48、`radius-md`、`body` 文字、前置图标 `ink-muted`；按下出现 `inset-sm` 内阴影，底色不变。
- 从锚点角展开：`scale-enter` → 1 + 淡入 `dur-panel`；离开反向 `dur-exit`。
- 破坏性操作放最后、分组隔开、用 `danger`；不可撤销时再用对话框确认。
- 原生：`NeumorphMenu` / `MotionMenu`（菜单栈共用一个外框，子页交叉淡化）。

#### DirectoryGroup

侧栏里的一个工作目录：一行目录名，展开成一棵细的会话树。侧栏本身就是那块凸起的面，目录不再各自做卡片、不再套凹槽托盘。

- 属性：`name`、`count`、`open` / `defaultOpen`、`onToggle`、`active`、`sessions` `[{ id, title, agent, status, statusTone, time }]`（最近 3–4 条）、`current`、`onOpen`、`onNew`、`onAll`、`total`。
- 目录行：高 48、内边距 `space-8`；文件夹图标 18（`ink-muted`，展开时实心、`ink`）→ 名称 `label-strong` 13/600 单行省略 → 计数 `caption` → 16 的箭头（展开转 90°）。目录里有正在运行的会话、且目录折叠着时，在名称后亮一颗带绕行弧的状态点；展开后由会话行自己说。
- 会话树：从文件夹图标中线向下一条 1px `hairline` 引导线，会话行距引导线 16，正好与目录名左缘对齐。
- 会话行：高 48、单行——14 的 Agent 标记（Agent 色只在这个小标记上，不再写彩色 Agent 名）+ 标题 `label` 13 单行省略 + 右侧一项元信息：运行中 / 待审批等活动状态显示状态点 + 状态词，空闲显示时间（「2 小时前」「昨天」）。
- 树尾：左边「+ 新建会话」（`accent`），右边「全部 36 个 ›」（`ink-muted`），都是 `caption`，命中区 48。
- 按下：行按下去成 `inset-sm`。旁边打开着的会话（平板分栏）是唯一常驻的凹陷行，标题 `accent` + 600。
- 目录之间 2，展开的树下方留 8。不用卡片阴影、不用分隔线区分目录——缩进和引导线就够了。
- 不要：在侧栏里用 15 号字或两行会话卡；把每个目录做成凸起卡片；在每一行重复「新建」按钮。
- 原生：Android `DrawerDirectorySlice` / `DrawerBranch`、iOS `directoryGroup` 去掉外框与托盘绘制，改为行 + 引导线；字号按 `label` / `label-strong` / `caption`。

### 11.5 内容

#### SessionCard

首页上的一个会话：Agent 识别槽、标题、路径，以及 Agent 名称与实时状态。

- 属性：`agent`、`title`（最多两行）、`path`（等宽单行，原生从中间省略）、`status`、`statusTone`、`syncing`、`selecting`（多选模式）、`selected`、`onClick`。
- 首页卡片行数固定：标题保留两行高度；路径、模型、状态各一行，超长内容省略。空模型以 Agent 名称占位，状态为空时仍保留行槽。
- `raised-md`、`radius-lg`、内边距 `space-16`，卡片间 `space-12`。按下走深度过渡。
- 多选（长按进入）：深度不变；从触点铺开 `accent-soft`，加 1px `accent` 轮廓；右侧选择标记的槽位一直预留。
- Agent 色只在 Agent 名称上；状态由状态点承载。
- 新会话的卡片不是凭空插入的：它是启动后的 `SessionDraft` 在原位换成的，标题取首句或目录名。

##### 左滑关闭（M10）
- 卡片下面是同色 `inset-md` 的槽，右侧一个 `disc-xs` 凹座里放关闭图标，外面一圈 2px 进度环，旁边是「关闭」。
- 卡片跟手左移，进度环随距离填满；到卡片宽度的 **40%** 时"上膛"：凹座浮起成 `raised-sm` 并轻弹到 1.12（`ease-pop`），图标、进度环、文字变 `danger`，文字换成「松手关闭」，原生给一次确认触觉。
- 过了 40% 继续拖有阻力（0.4 倍）；拖回 40% 以内立即解除，字和颜色退回。
- 只有上膛状态松手才关闭；没到 40% 的快甩一律弹回——不靠速度猜意图。
- 关闭后内容先淡出再收起高度；关闭是乐观的、可恢复的（toast 里「撤销」）。

#### SessionDraft

新建会话：在首页列表顶上从材料里"升起"一张草稿卡片，选好 Agent 和目录后可直接启动，也可先写第一句话。提交时，这张卡片长成会话页。

- 属性：`agent`、`onAgent(a)`、`path`、`onDir()`（打开目录选择）、`text`、`onText(t)`、`onSend()`、`onCancel()`、`phase` `'slot' | 'risen' | 'sink'`、`autoFocus`。
- 卡片内容（Agent 作用域）：
  - 一排四个 Agent 标记（`disc-sm` 圆面，命中区 48）：选中的按下去（`inset-sm`）并显示本色，旁边写 Agent 名（`label-strong`，Agent 色）；其余灰度、`opacity-dim`。默认是上次用的 Agent。
  - Codex 同时可用终端版与桌面版时，点 Codex 名称打开版本菜单；创建后的会话保留所选版本。
  - 目录：文件夹图标 + 等宽路径（`code-sm`）+ 下拉箭头，点开是 `ChoiceList` 底部面板「在哪个目录里开始」。从侧栏某个目录下的「+ 新建会话」进来时，已经带上那个目录。
  - 输入槽：`inset-md`，占位「让 Codex 做什么？」随 Agent 变；文字多了自然长高（最多 6 行）。右侧圆钮使用 Agent 色，空输入时显示可点击的启动三角，有内容时切换发送箭头；连接、目录和启动状态决定是否可用。回车提交，Shift+回车换行，Esc 收起。
- 编排（都用现有动效 token）：
  1. **开槽**：顶栏的 + 按下并转 45° 成 ×；列表最上方以自然高度展开一道槽（`dur-collapse` `ease-standard`），此时卡片是凹陷——材料被压出一个坑。
  2. **升起**：约 200ms 后，同一块材料从凹陷经平面推成凸起（`--ob-down` → `--ob-rest` 一次深度变形，`dur-selection` `ease-emphasized`）；内容晚 120ms 上浮 4px 淡入；输入槽获得焦点。其余会话卡退到 `opacity-dim` 且暂不可点。
  3. **启动 / 发出**：会话页从这张卡片的位置和圆角长成整屏（`clip-path` 由卡片矩形展开到全屏，`dur-page` `ease-page`）；有首句时作为第一条用户消息飞入，回复随即开始；空输入沿原开窗路径创建会话，不生成消息。页面盖住列表后，草稿在底下换成真正的会话卡（标题取第一句话前 22 字或目录名，状态随实际启动结果更新）。返回时就是正常的推回。
  4. **收起**：再点 ×（或 Esc）——内容先淡出、卡片按回凹陷，再合上槽。写了一半的话会留着，下次新建时还在，并用一条 toast 告诉用户。
- 减少动画：开槽、升起、展开都直接切换，焦点与顺序不变。
- Agent、目录和可选首句放在同一张卡片里；操作按钮表达直接启动与发送首句。
- 电脑会话在明确提交时创建，展开卡片保持本地草稿；动效沿用从材料里升起与形状展开。

#### ListGroup

设置里的一个分区：上方一行 `ink-muted` 分区标题，下面一张凸起卡片装着各行。

- `ListGroup` 属性：`title`、`children`（行）。`ListRow` 属性：`title`、`sub`、`leading`（如 `AgentEmblem`）、`trailing`（`StatusPill`、次要文字、对勾或 `RowAction`）、`onClick`。
- `RowAction`：行内文字操作，前置图标 + `accent` 13/600（如「⇄ 切换」），命中区 48。
- 行高 ≥48，只用间距分隔。卡片里的胶囊和按钮都是平的明度台阶。
- 用于设置、连接详情、供应商列表。需要搜索的长列表改用推入页面。
- 原生：设置分组与 `StatusRow`。

### 11.6 会话

#### AssistantCard

Agent 回复里一个可见的步骤——思考、正文或工具——放在一张以 Agent 标签开头的凸起卡片上。

- 属性：`agent`、`children`（Markdown 块、`CodeBlock`、`ToolGroup`）、`footer`（用时、文件改动，`caption`）。
- `raised-md`、`radius-lg`、内边距 `space-16`，块与块间 `space-12`；嵌套面板（代码、工具）是平的，`radius-sm`。
- 整张卡在 Agent 作用域内：复制反馈、链接、焦点用 Agent 色。
- 工具之后开始新的正文或思考时另起一张卡（ADR-0066）。首次出现 `dur-panel` 上浮淡入；流式增高 `dur-reply-grow`；新字形逐个渐显。

#### UserMessage

用户自己的消息：右侧的凹陷气泡，送达状态放在下方的固定槽位。

- 属性：`children`、`status` `'sending' | 'queued' | 'unconfirmed' | 'failed'`（已确认时省略）、`reason`（失败原因）、`arriving`（播放发送飞入）。
- 凹槽：底色同页面 + `inset-md`、`radius-lg`、内边距 `space-12` × `space-16`、最宽 85%。不写「你」——位置已经说明是谁。
- 状态行占用原本放复制 / 回退的位置，不在聊天里新增行：`caption` 文字 + `disc-xs` 操作（撤回、核对、重新发送、放回输入框、删除）。
- 未确认不是已发送：来源确认之前不显示成功（ADR-0049）。
- 发送飞入：输入内容在 `dur-send`（280 + 160）内飞进这个气泡。

#### CodeBlock

助手卡片里的代码：平的凹陷面板，带语言名和复制操作。

- 属性：`lang`、`code`。
- 底色同所在卡片，`inset-sm` 内阴影，`radius-sm`（嵌套的凹陷保留内阴影）。头部高 40：语言名 `caption`，`disc-xs` 复制带勾号反馈。正文 `code` 13/20，横向滚动，不换行不截断。
- 超过 12 行的长代码默认折叠，展开保持阅读锚点。

#### ToolGroup

助手卡片里一组连续的工具调用，默认折叠。

- 属性：`title`（默认「N 个工具调用」）、`tools` `[{ name, arg, status: 'done' | 'running' | 'error' }]`、`duration`、`more`（「再显示 N 个」后面的数量）、`defaultOpen`。
- 平的 `surface-lift` 面板、`radius-sm`；头部高 48：工具图标、13/600 标题、运行中或用时、随折叠旋转的箭头。
- 每行：状态图标、工具名、`code-sm` 参数（省略号）；行间 `hairline`。分页加载的工具按列表插入动效出现。
- 外框身份跟随第一个原生工具，实时与历史之间切换时外框不重建（MOT-27）。

#### Composer

会话输入栏：信息行（路径、权限）在上，下面是附件圆钮、凹陷输入槽和发送 / 停止圆钮。

- 属性：`agent`、`placeholder`（默认「发给 <Agent>，/ 命令」）、`path`、`permission`、`running`（显示停止代替发送）、`defaultValue`。
- 输入槽：底色同页面（`surface-base`）+ `inset-md`、`radius-md`，静止 56，随文字增高到 168 后滚动。聚焦 `focus-halo` 用 Agent 色。
- 附件与发送为 `disc-md`、Agent 色；停止为实心 `stop`、`danger`。发送与停止共用一个槽，尺寸不变。
- 信息行：`code-sm` 路径 + 小号 `link` 打开权限面板；与页面同底色，无分隔线。

### 11.7 反馈与叠加

#### StatusPill

小号凸起胶囊，说明连接或模式：状态点 + 一两个词 + 可选的锁。

- 属性：`tone` `'neutral' | 'success' | 'warning' | 'danger'`、`syncing`、`icon`（如加密局域网路径的 `lock`）、`children`。
- 高 32、`radius-full`、`raised-sm`，文字 `label`、用状态色（neutral 为 `ink-muted`）。
- 首页连接胶囊：「局域网 🔒」/「中继」。平时是静止的实心点；只有真的在同步或重连时，点外才有一道弧绕行，文字和宽度不变。
- 在卡片里变成平的明度台阶。不要当按钮用。

#### Notice

浮在内容上的短反馈，报告结果但不移动布局。

- 属性：`tone` `'neutral' | 'success' | 'warning' | 'danger'`、`icon`（按 tone 有默认）、`children`（一句话）、`action`（小号按钮）、`onClose`、`leaving`。
- `raised-lg`、`radius-md`、高 ≥48；图标用状态色，文字 `ink`。
- 上移 12px + 淡入 `dur-panel`，停 `hold-toast`，淡出 `dur-exit`。带操作或是错误时，直到关闭才消失。
- 覆盖在内容之上（`z-toast`），从不推开聊天或列表。

#### Progress

凹陷的进度槽：已知进度用强调色填充，未知进度来回扫动。

- 属性：`value`（0–1，`null` 为不确定）、`label`、`meta`（如“42%，已用 12 秒”）、`ariaLabel`（标签已在别处显示时的读屏名称，如配额栏）。
- 槽高 8、`inset-sm`，填充 `accent`（会话内为 Agent 色）。宽度变化 `dur-state`；不确定段每 `dur-loop` 扫一次。
- 替代 Material `LinearProgressIndicator` 和 Host 的 200ms 线性进度条。首帧优先展示缓存，而不是进度。

#### Dialog

居中的确认：给重要或不可撤销的决定。

- 属性：`title`（写明对象的问句：「取消配对 workstation？」）、`children`（后果，`ink-muted`）、`actions`（按钮：安全的在前，提交的在后）。
- `raised-lg`、`radius-xl`、内边距 `space-16`、间距 `space-20`；里面的按钮是平的明度台阶，`radius-md`。背后是 `opacity-scrim` 的 `scrim`。
- 进入：`scale-enter` → 1 + 淡入（`dur-panel`）；离开 `dur-exit`。
- 不承载列表或超过一个字段的表单——用底部面板或推入页面。
- 原生：`NeumorphDialog`（保留原生模态语义）。

#### Sheet

底部面板：不离开当前页，从一组里做选择——模型、思考强度、权限、目录。

- 属性：`title`、`children`（`ChoiceList`、ListGroup、Segmented、整宽按钮）。会改变运行状态的选择配一个写清后果的主按钮，点选本身不生效。
- 上方两角 `radius-xl`、`raised-lg`、内边距 `space-16`，顶部 36×6 的凹陷把手。里面的内容按嵌套处理。
- 上升 24px + 淡入 `dur-panel`；可跟手拖动，松手 spring-drag 回位；向下关闭 `dur-dismiss`。
- 替代 Material `ModalBottomSheet` 的默认外观（把手、表面着色、时长）。

### 11.8 供应商

#### ProviderDial

供应商圆盘：一只凸起的大圆盘，圆心在屏幕左侧之外，只露出右边一大段弧，从圆心往外读——**空心凹陷 → 里圈选 Agent → 外圈选这个 Agent 的配置 → 盘外的配置名**。拨动只是浏览，切换必须另按按钮并确认。

##### 结构（从圆心往外）
- **大小与裁切**：先定盘缘位置（给盘外文字留至少 136px），再用 `zoom` 让圆盘向左长大、越过屏幕边缘。Orbis 用 `zoom: 1.6`：圆心在屏幕外约 50px，圆盘只露出一大段弧，比整盘露出（1×）更有分量。盘高超出区域时上下渐隐。
- **里层按"看得见的部分"定尺寸**：圆心出屏后，空心和里圈不再跟着盘按比例放大，而是保证露出的量——空心至少露出 26px，Agent 带至少 72px 宽。所以 1.6× 时空心是贴在左边缘的一道月牙，里圈变成贴边的一条竖向 Agent 带。
- **刻度角跟着半径走**：盘越大，同样角度的弧越长，所以刻度角按半径反算，让相邻配置名始终相隔约 96px（1.6× 时约 18°，1× 时 24°），相邻 Agent 标记相隔约 56px（1.6× 时约 29°，1× 时 40°）。手感上每拨一格的距离不随大小变化。
- **空心**：圆盘正中一个小圆凹陷（半径约为盘的 15%，并保证露出 ≥26px），与盘面同色，只靠 `inset-md` 内阴影表现深度；里面什么都不放。
- **里圈（Agent 轮毂）**：`raised-sm`，半径约为盘的一半。各 Agent 标记（20px）沿轮毂排列、永远正立；0° 处有一个固定的 `inset-sm` 圆窗，转进窗里的 Agent 显示本色，其余灰度、40% 透明；会被屏幕边缘切开的标记不画。
- **护城河**：轮毂外一圈 24px 的同色 `inset-sm` 凹槽，把两层在视觉和手感上分开。从这里按下的触摸什么都不做，两层的操作区永远隔着它。轮毂边缘有一圈小圆点做防滑纹，告诉手指"这是另一个能单独转的钮"；它是纹理不是刻度，所以用点不用线。
- **外圈（配置盘）**：`raised-lg` 盘面，盘缘三级细刻度（每 3°，配置处为长刻度），刻度内每个配置一颗点，使用中的点为 `success`。
- **盘外**：0° 处一颗固定的 Agent 色指示点；配置名像收音机刻度沿盘外圆弧排列，左对齐、永远正立。正对指示点的一项显示 Agent 名（12）、配置名 20/600、类型说明、「使用中」；相邻项只留名字，按角距离缩小变淡。盘右侧至少给刻度文字留 136px，盘的半径据此收缩。

##### 防误操作
1. **两个操作区隔开**：Agent 带（空心以外、轮毂以内）只换 Agent；配置盘（护城河以外，包括盘外文字）只换配置；空心和护城河都不响应。按下时按区域锁定，整个手势不换。按下的瞬间就显示握住了哪一层：握住 Agent 带时轮毂浮起、配置文字退到 `opacity-dim`；握住配置盘时 Agent 带整体退到 `opacity-dim`。
2. **里圈更难拨动**：起拨阈值 10px（外圈 4px）；每个 Agent 需要拖 84px；刻度带"吸附"，停在一个 Agent 附近时会粘住，过了中点才让开；松手不按速度惯性滑行，只落到最近的一个。
3. **换 Agent 时外圈回到正在使用的配置**，绝不停在上次随手浏览到的那一项；配置名整体淡入，提示内容已换。
4. **边缘让给系统**：触屏时距左边缘 20px 内按下不响应，留给系统返回手势。
5. **拨动从不切换**：圆盘只回报"正在看哪一项"（`onChange` / `onGroupChange`）。任一圈还在拖动或回弹时 `onMoving(true)`，页面应禁用主按钮，停稳后才可点。切换还需对话框确认，标题同时写出 Agent 和配置：「切换 Codex 到 relay-b？」。
6. **两种手感**：原生在外圈每过一格给轻触觉（selection tick），里圈每过一个 Agent 给一次较重的触觉（clock tick / impact light），指示点或圆窗同步轻跳。

##### 键盘与读屏
整个圆盘是 `group`，里面两个 `slider`：轮毂（Agent）和盘面（某 Agent 的配置），各自 Tab 可达，↑ / ↓、Home / End 拨动，读出名称而不是序号。

##### 页面里怎么放
不再需要 Agent 分段控件。上方分开展示电脑名、Agent 名称与配置数量，例如“Codex，电脑上保存的 4 个配置”。圆盘占满中间剩余高度（至少 300），下方依次是配额和主按钮；当前配置位置与配置总数独立显示，不显示操作说明句。

##### 配额
有订阅配额的配置同时显示「5 小时」和「7 天」两栏：窗口名、剩余百分比（28/600 `ink`，`%` 用 `ink-muted`）、6 高进度槽（Agent 色）、重置时间。剩余 ≤20% 时数字与进度改 `danger`，窗口名右侧加「⚠ 即将用完」。没有配额的配置在同一高度显示「这个配置不提供配额查询」，布局不跳。

##### 主操作
独占型 Agent：「切换到 relay-b」→ 对话框确认；正在使用时为禁用的「正在使用 本机配置」。叠加型（Pi）：「启用 / 移出」。

##### 不要
- 在圆盘上直接切换，或让松手惯性把里圈带过一个以上 Agent。
- 往空心里放图标或文字。
- 把文字沿半径旋转；用英文大写、等宽小字、编号或私有配色装饰它。

##### 原生
替换 `ProviderDialScreen.kt` 的绘制与私有 palette：保留 `ProviderDialGeometry` 的角度换算，刻度角按半径反算（配置名间距约 96px、Agent 间距约 56px）、两端停止；里圈无惯性、吸附；落点动画三次缓出约 220–460ms。去掉上方 Agent 横拨。配额两窗口直接读 `five_hour` / `seven_day`。

## 12 Token 一览

四个主题：`light` 雾蓝浅色（默认）、`dark` 雾蓝深色、`sage-light` 灰绿浅色、`sage-dark` 灰绿深色。颜色与阴影按主题取值，其余 token 全主题共用。

### 12.1 颜色

| token | light | dark | sage-light | sage-dark | 用途 |
| --- | --- | --- | --- | --- | --- |
| `surface-base` | `#e6ebf4` | `#23262e` | `#e0e7df` | `#33393d` | 底板。页面底、状态栏 / 导航栏、所有凸起表面的面，也是凹陷的底——凹陷是同一块材料被按下去，不换颜色，只靠内阴影。每屏一个，任何页面不得自带底色。 |
| `surface-lift` | `#edf1f8` | `#292d36` | `#e8eee5` | `#3a4246` | 高一层。凸起卡片里嵌套的凸起元素（工具组、嵌套按钮、列表头）的面；靠明度区分，不再叠外阴影。 |
| `surface-top` | `#f3f6fb` | `#2f333d` | `#f0f5ed` | `#424b50` | 最高一层。嵌套两层的凸起元素、桌面端悬停。其上文字仍用 ink / ink-muted。 |
| `highlight` | `#ffffff` | `#343946` | `#f8fbf5` | `#4a555a` | 成对柔影的亮半边（左上）。只给阴影 token 和凹刻字标用，从不作填充。 |
| `shade` | `#a6b2c6` | `#0a0c11` | `#b2c0b0` | `#1c2427` | 成对柔影的暗半边（右下），带色墨而非纯黑。只给阴影 token 和凹刻字标用。 |
| `hairline` | `#c9d1de` | `#3a4150` | `#c7d1c5` | `#4a5653` | 同一表面内的 1px 分隔、历史树连线、禁用控件轮廓。装饰性：不靠它区分任何信息。 |
| `scrim` | `#2a3344` | `#05070a` | `#203626` | `#0b1214` | 对话框、底部面板、抽屉下的带色遮罩，以及被推入页覆盖时的下层阴影。总是配 opacity-scrim，不作实色。 |
| `ink` | `#232a36` | `#dde1e9` | `#2f4235` | `#eff3f0` | 主要文字与图标，在 base / lift / top 上四个主题都 ≥7.9:1：标题、正文、消息、激活图标。 |
| `ink-muted` | `#4a5364` | `#b8c0ce` | `#4f6153` | `#bac7c2` | 次要文字，在 base / lift / top 上都 ≥5.1:1：路径、元数据、分区标题、占位符、未选中标签、空闲圆钮的图标。 |
| `ink-faint` | `#737d90` | `#858d9c` | `#6e7f6f` | `#8e9c97` | 禁用文字与图标、转盘刻度、空闲状态点。约 3:1，不承载需要阅读的信息。 |
| `accent` | `#2f5287` | `#afc6e6` | `#41603f` | `#a9ddc1` | Orbis 自己的交互墨色（Agent 会话之外）：链接、选中的标签与分段、主按钮文字、批量选择轮廓。会话内换成该 Agent 的颜色。四个主题在 base / lift / top 上都 ≥5.6:1。 |
| `accent-soft` | `#d0d9e7` | `#343944` | `#d3dcd2` | `#414d4d` | 唯一的着色底：批量选择时卡片和行的淡底（S15），配 1px accent 轮廓。其上 ink、ink-muted、accent 与 Agent 色都 ≥4.5:1。 |
| `on-accent` | `#ffffff` | `#16233a` | `#ffffff` | `#173322` | accent 填充上的字形：选择标记里的对勾。对 accent ≥7:1。 |
| `focus-ring` | `{accent}` | `{accent}` | `{accent}` | `{accent}` | 键盘焦点（Host、官网、外接键盘）：控件外 2px 处的 2px 实线环，在所有表面上 ≥3:1。触摸聚焦输入框改用 focus-halo。 |
| `success` | `#1a6a4d` | `#84d6b3` | `#1a6a4d` | `#8fddb8` | 已连接、完成、运行中。必须配文字（已连接、运行中）或对勾，从不单独出现。 |
| `warning` | `#845000` | `#f2c26b` | `#845000` | `#f2c26b` | 等人处理或降级：等待审批、未确认送达、重连中、配额将尽。配文字或图标。 |
| `danger` | `#ad241c` | `#ffb4ab` | `#ad241c` | `#ffb4ab` | 错误、发送失败、离线、破坏性操作（删除、取消配对）与停止图标。只上墨，表面保持材质。 |
| `agent-pi` | `#8c3870` | `#f0a9d3` | `#8c3870` | `#f0a9d3` | Pi 的身份色（莓紫）。由铁锈改来，让 Pi 与 Claude 不再同色。用于名称文字和 Pi 会话内的操作与焦点；Pi 标记保留自身三色。 |
| `agent-codex` | `#00655d` | `#77d6c7` | `#00655d` | `#77d6c7` | Codex 的身份色（青），终端与桌面版相同。为单色 Codex 标记着色，用于名称和 Codex 会话内的操作。 |
| `agent-deepseek` | `#3550cf` | `#a9bbff` | `#3550cf` | `#a9bbff` | DeepSeek 的身份色（品牌蓝 #4D6BFE 加深，使 13 号字达到 4.5:1）。为鲸鱼标记着色，用于名称和 DeepSeek 会话内的操作。 |
| `agent-claude` | `#9a4521` | `#f0b48c` | `#9a4521` | `#f0b48c` | Claude Code 的身份色（陶土）。用于名称和 Claude 会话内的操作；Claude 标记保留自身颜色。 |

### 12.2 阴影

成对柔影，光从左上来。外阴影只给最外层（S02），嵌套的凸起元素是平的明度台阶；内阴影不受此限，凹陷在任何层级都保留，而且不换底色。

| token | light | dark | sage-light | sage-dark | 用途 |
| --- | --- | --- | --- | --- | --- |
| `raised-sm` | `2px 2px 5px #a6b2c68c, -2px -2px 5px #ffffffe6` | `2px 2px 5px #0a0c11b3, -2px -2px 5px #343946cc` | `2px 2px 5px #b2c0b0a6, -2px -2px 5px #f8fbf5cc` | `2px 2px 5px #1c2427b3, -2px -2px 5px #4a555ab3` | 小号凸起：28–36 圆钮、复选框、菜单项、标签栏项、分段项、状态胶囊。原生 shadowScale 0.4（位移 / 模糊 1.6）。 |
| `raised-md` | `4px 4px 10px #a6b2c68c, -4px -4px 10px #ffffffe6` | `4px 4px 10px #0a0c11b3, -4px -4px 10px #343946cc` | `4px 4px 10px #b2c0b0a6, -4px -4px 10px #f8fbf5cc` | `4px 4px 10px #1c2427b3, -4px -4px 10px #4a555ab3` | 默认凸起：按钮、40 圆钮、会话卡、助手卡、目录外框、设置分组。原生 shadowScale 0.65（2.6）。 |
| `raised-lg` | `8px 8px 22px #a6b2c68c, -8px -8px 22px #ffffffe6` | `8px 8px 22px #0a0c11b3, -8px -8px 22px #343946cc` | `8px 8px 22px #b2c0b0a6, -8px -8px 22px #f8fbf5cc` | `8px 8px 22px #1c2427b3, -8px -8px 22px #4a555ab3` | 漂浮层：锚点菜单、对话框、底部面板、抽屉边缘、短反馈。原生 shadowScale 1.0（4）。 |
| `inset-sm` | `inset 2px 2px 4px #a6b2c68c, inset -2px -2px 4px #ffffffe6` | `inset 2px 2px 4px #0a0c11b3, inset -2px -2px 4px #343946cc` | `inset 2px 2px 4px #b2c0b0a6, inset -2px -2px 4px #f8fbf5cc` | `inset 2px 2px 4px #1c2427b3, inset -2px -2px 4px #4a555ab3` | 小号凹陷：选中的标签与分段、按住的 28–36 圆钮、勾选的复选框、进度槽、开关槽、识别槽。底色就是所在表面的面；嵌套时也保留。 |
| `inset-md` | `inset 3px 3px 7px #a6b2c68c, inset -3px -3px 7px #ffffffe6` | `inset 3px 3px 7px #0a0c11b3, inset -3px -3px 7px #343946cc` | `inset 3px 3px 7px #b2c0b0a6, inset -3px -3px 7px #f8fbf5cc` | `inset 3px 3px 7px #1c2427b3, inset -3px -3px 7px #4a555ab3` | 默认凹陷：输入框、搜索槽、输入栏、用户消息、代码块、目录托盘、按住的按钮与卡片。底色不变，深度只来自这组内阴影；嵌套在凸起表面里时也保留。 |
| `engrave` | `-0.9px -0.9px 0 #a6b2c699, 0.9px 0.9px 0 #ffffffeb` | `-0.9px -0.9px 0 #0a0c1199, 0.9px 0.9px 0 #343946eb` | `-0.9px -0.9px 0 #b2c0b099, 0.9px 0.9px 0 #f8fbf5eb` | `-0.9px -0.9px 0 #1c242799, 0.9px 0.9px 0 #4a555aeb` | 仅用于凹刻 Orbis 字标的文字阴影（暗壁左上、亮壁右下，浮雕 1.8）。 |
| `focus-halo` | `0 0 0 1px #2f528747, 0 0 0 6px #2f52871a` | `0 0 0 1px #afc6e652, 0 0 0 6px #afc6e61f` | `0 0 0 1px #41603f47, 0 0 0 6px #41603f1a` | `0 0 0 1px #a9ddc152, 0 0 0 6px #a9ddc11f` | 聚焦输入框的两圈柔光（不改尺寸，160ms）。会话内用 Agent 色。 |
| `flat` | `none` | `none` | `none` | `none` | 禁用控件与嵌套在其他表面里的凸起元素：去掉外阴影，保留填充。凹陷的内阴影不受影响。 |

### 12.3 字体

- `sans`：system-ui, -apple-system, "SF Pro Text", "PingFang SC", Roboto, "Noto Sans SC", "Segoe UI", "Microsoft YaHei UI", sans-serif
- `mono`：ui-monospace, "SF Mono", Menlo, "Roboto Mono", "Cascadia Mono", Consolas, monospace

| 样式 | 字号 / 行高 | 字重 | 字族 | 用途 |
| --- | --- | --- | --- | --- |
| `display` | 28 / 34 | 600 | sans | 只给数字英雄位：配额剩余、Host 首页统计。等宽数字。 |
| `title` | 20 / 28 | 600 | sans | 页面与对话框标题、Orbis 字标、顶栏里的会话标题。 |
| `body-strong` | 15 / 24 | 600 | sans | 卡片标题、列表行标题、中号与整宽按钮文字、消息里的强调。 |
| `body` | 15 / 24 | 400 | sans | 消息正文、说明、输入内容、对话框正文、菜单项。阅读字号。 |
| `label-strong` | 13 / 20 | 600 | sans | 小按钮文字、选中的标签、Agent 名称。 |
| `label` | 13 / 20 | 400 | sans | 元数据、状态词、分区标题（ink-muted）、标签栏、菜单次要行。 |
| `caption` | 12 / 18 | 400 | sans | 全 App 最小字号：时间、计数、提示、配额周期。任何文字不小于 12。 |
| `code` | 13 / 20 | 400 | mono | 代码块、diff、工具输出。 |
| `code-sm` | 12 / 18 | 400 | mono | 卡片与输入栏里的路径、工具参数、协议名。路径从中间省略，扩展名不省略。 |

### 12.4 间距

4px 栅格。代码里的非栅格值（3、5、7、9、10、11、13、14、17、18、21、22…）在「落地映射」里就近归档。

| token | 值 | 用途 |
| --- | --- | --- |
| `space-2` | `2px` | 最细间隙：紧凑行里的叠行、徽标内偏移。 |
| `space-4` | `4px` | 图标簇内间距、卡片头里标签与值的行距。 |
| `space-6` | `6px` | 按钮内图标与文字、Agent 标记与名称。 |
| `space-8` | `8px` | 胶囊、按钮之间，列表项内部堆叠。 |
| `space-12` | `12px` | 卡片之间；卡片内嵌面板的内缩（radius-lg − 12 = radius-sm）。 |
| `space-16` | `16px` | 卡片内边距、对话框 / 抽屉 / 底部面板内边距、输入框左右。 |
| `space-20` | `20px` | 手机页面左右边距、中号按钮左右内边距。 |
| `space-24` | `24px` | 页面分区之间、分区标题上方。 |
| `space-32` | `32px` | 页面大区块之间、空状态留白。 |
| `space-40` | `40px` | 桌面页面边距（Host、官网）。 |
| `space-48` | `48px` | 桌面分区间距。 |
| `space-64` | `64px` | 仅官网的大节奏。 |

### 12.5 圆角

同心：子圆角 = 父圆角 − 两者之间的内距。圆钮与胶囊保持 radius-full。

| token | 值 | 用途 |
| --- | --- | --- |
| `radius-xs` | `8px` | 复选框、附件缩略图、行内代码。 |
| `radius-sm` | `12px` | 卡片里的嵌套面板（代码块、工具组、配额槽）、40 高的小按钮。= radius-lg − space-12。 |
| `radius-md` | `16px` | 控件：按钮、输入框、输入栏、搜索槽、菜单项、标签项、分段、短反馈。 |
| `radius-lg` | `24px` | 卡片与容器：会话卡、助手卡、用户消息、目录外框、锚点菜单、设置分组。 |
| `radius-xl` | `32px` | 对话框与底部面板（上方两角）。子元素用 radius-md（32 − 16）。 |
| `radius-full` | `999px` | 圆钮、状态点、胶囊、选择标记。圆形不做同心换算。 |

### 12.6 尺寸

可见尺寸；阴影画在外面，不计入布局。

| token | 值 | 用途 |
| --- | --- | --- |
| `touch-target` | `48px` | 所有平台的最小命中区；可见圆面可以更小，命中区不能。 |
| `field-height` | `56px` | 输入框、输入栏静止高度、整宽按钮。 |
| `control-height` | `48px` | 中号按钮、分段、菜单项、列表行、标签项的最小高度。 |
| `control-height-sm` | `40px` | 卡片底部和对话框里的小按钮。 |
| `bar-height` | `56px` | 顶栏与底部标签栏的内容高度（系统安全区另加）。 |
| `disc-lg` | `44px` | 首页卡片的 Agent 识别槽。只用于识别，不是按钮。 |
| `disc-md` | `40px` | 默认图标圆钮：顶栏操作、输入栏附件 / 发送 / 停止。 |
| `disc-sm` | `36px` | 卡片旁、行内的次要操作（复制、展开、新建）。 |
| `disc-xs` | `28px` | 待确认消息下的密集操作（重发、放回、删除）。命中区仍为 48。 |
| `icon-md` | `22px` | disc-md / disc-lg 里的图标；标签栏图标。 |
| `icon-sm` | `18px` | disc-sm 与中号按钮里的图标。 |
| `icon-xs` | `16px` | disc-xs 与小按钮里的图标；贴着文字的图标。 |
| `icon-inline` | `14px` | 12–13 号状态文字里的图标（错误、锁）。 |
| `dot` | `8px` | 状态点（连接、运行状态）：空闲是空心圈，有状态时是实心点。 |
| `dot-ring` | `16px` | 状态点占的位置，也是「正在工作」时那道弧绕行的圆。 |
| `checkbox` | `24px` | 复选框与批量选择标记的可见尺寸。 |
| `reading-width` | `720px` | 平板与桌面上聊天内容和设置栏的最大宽度。 |
| `drawer-width` | `320px` | 目录抽屉宽度；平板常驻侧栏宽度。 |
| `host-sidebar` | `232px` | Windows / macOS Host 导航栏宽度。 |

### 12.7 时长

与 Android InteractionMotion.kt、iOS InteractionMotion.swift 同源。减少动画时除 dur-state 的交叉淡化外全部为 0。

| token | 值 | 用途 |
| --- | --- | --- |
| `dur-press` | `80ms` | 按下：字形缩到 scale-press，表面由凸起沉到凹陷。无最短按住。 |
| `dur-release` | `160ms` | 松开：字形与表面回位；点击在抬起时触发，不等动画。 |
| `dur-state` | `160ms` | 小状态变化：焦点柔光、选择标记、复制 ↔ 勾号、启用 ↔ 禁用。 |
| `dur-panel` | `220ms` | 出现：菜单、对话框、底部面板、短反馈进入；回复卡首次出现；外观交叉淡化。 |
| `dur-selection` | `260ms` | 从触点扩散的批量选择；标签与分段的深度交接。 |
| `dur-collapse` | `260ms` | 自然高度展开 / 收起（工具组、思考、目录托盘、列表插入 / 移除）。 |
| `dur-exit` | `160ms` | 离开：菜单、短反馈、对话框退出（ease-in）。 |
| `dur-dismiss` | `180ms` | 程序化关闭页面（返回按钮）、抽屉松手后关闭。 |
| `dur-reply-grow` | `180ms` | 流式回复卡片增高。 |
| `dur-fade-out` | `90ms` | fade-through 前半：旧内容淡出（根标签切换、离散文字替换）。 |
| `dur-fade-in` | `210ms` | fade-through 后半：新内容上浮 8px 淡入。 |
| `dur-send` | `440ms` | 输入栏 → 消息的飞入：280 飞行 + 160 展开。 |
| `dur-page` | `320ms` | 原生整页弹簧（spring-page）在官网 / Host 上的等效时长。 |
| `dur-loop` | `1100ms` | 任何不确定循环的一周期：进度扫动、状态点外的绕行弧、骨架高光。 |
| `hold-copy` | `2500ms` | 复制后勾号停留多久再回到复制图标。 |
| `hold-toast` | `4000ms` | 短反馈停留时长；带操作或错误的反馈直到关闭。 |

### 12.8 曲线与弹簧

原生弹簧保持弹簧（spring-drag k1200/c80、spring-page k260/c24、spring-pop k380/c18）；这里的 cubic-bezier 是网页近似。

| token | 值 | 用途 |
| --- | --- | --- |
| `ease-emphasized` | `cubic-bezier(0.2, 0, 0, 1)` | 字形按压 / 松开、复制变形、回复增高与首现、标签深度交接：起步快、收尾长。 |
| `ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | 进入与状态变化（dur-state、dur-panel、dur-selection、fade-in）。 |
| `ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | 离开（dur-exit、dur-dismiss、fade-out）。 |
| `ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | 留在屏幕上并改变尺寸的东西：折叠、工具栏切换、列表重排。 |
| `ease-pop` | `cubic-bezier(0.34, 1.4, 0.64, 1)` | spring-pop（stiffness 380、damping 18）的 CSS 近似：勾选、下载弹跳、小确认。 |
| `ease-page` | `cubic-bezier(0.32, 0.72, 0, 1)` | spring-page（stiffness 260、damping 24）的 CSS 近似：Host / 官网的整页推入与回位。 |
| `ease-linear` | `linear` | 只给时钟：不确定循环与发送飞行的时钟（各阶段再套自己的曲线）。 |

### 12.9 不透明度

| token | 值 | 用途 |
| --- | --- | --- |
| `opacity-glyph-pressed` | `0.82` | 按下时字形的不透明度（配合 scale-press）。 |
| `opacity-scrim` | `0.34` | 对话框、底部面板下遮罩的强度，也是被覆盖页面的最大阴影。 |
| `opacity-skeleton` | `0.6` | 加载骨架的凹陷线条（配合 dur-loop 高光扫过）。 |
| `opacity-dim` | `0.4` | 退后但仍在场的东西：没转进圆窗的 Agent、圆盘上没被握住的那一圈。 |

### 12.10 缩放

| token | 值 | 用途 |
| --- | --- | --- |
| `scale-press` | `0.94` | 按下时字形缩放。 |
| `scale-enter` | `0.96` | 菜单、对话框、底部面板进入时的起始缩放（配合淡入）。 |
| `scale-pop` | `1.12` | 确认弹跳的峰值（下载已受理、复制勾号）。 |

### 12.11 层级

| token | 值 | 用途 |
| --- | --- | --- |
| `z-bar` | `10` | 顶栏与底部标签栏。 |
| `z-drawer` | `20` | 目录抽屉与推入页面。 |
| `z-menu` | `30` | 锚点菜单。 |
| `z-scrim` | `40` | 模态层下的遮罩。 |
| `z-modal` | `50` | 对话框与底部面板。 |
| `z-toast` | `60` | 短反馈；在最上层，但不拦截自身范围外的触摸。 |

## 13 落地映射

把这套规范落到四端代码的对照表。原则：**先换 token 来源，再换组件，最后删私有值**；每一步保持 ADR-0051 的稳定性约束（阅读位置、消息身份、命中区不变）。

### 1. 一个 token 来源

| 端 | 现在 | 改为 |
| --- | --- | --- |
| Android | `OrbisTheme.kt` 的 `LightColors / DarkColors`（已被覆盖的蓝色）+ `DrawerMaterial.kt` 的灰绿 + `ProviderDialScreen.kt` 私有 palette + `AgentBrand.accent()` | 一个 `OrbisTokens.kt`：`OrbisMaterial(appearance, dark)` 产出四层 / 墨色 / 主色 / 状态 / Agent；`RemoteUi` 只保留尺寸；删除死代码 `LightColors / DarkColors` 与转盘 palette |
| iOS | `OrbisPalette`（classic + insetFocus 两套蓝） | `OrbisPalette(appearance: .mist / .sage, dark:)`，值与 tokens.json 同源；`orbis.visualStyle` 的 `classic / insetFocus` 迁为 `mist`，新增 `sage` |
| Host | `Main.qml` 里约 60 处硬写的 hex、字号 | 新增 `Theme.qml` 单例，属性名与 token 同名（`Theme.surfaceBase`、`Theme.radiusMd`、`Theme.durState`） |
| 官网 | `styles.css :root` 九个变量 | 直接使用本系统生成的 `tokens.css` |

外观设置：`orbis.appearance = mist | sage`（默认 mist），浅深跟随系统；四端读同一个枚举名。

### 2. 颜色：旧值 → token

| 旧值 | 出处 | token |
| --- | --- | --- |
| `#E6EBF4` / `#23262E` | iOS classic、Host、官网、ADR-0046 | `surface-base`（light / dark，原值） |
| `#EDF1F8` `#F3F6FB` | 同上 | `surface-lift` `surface-top` |
| `#DDE3EF` / `#1C1F26`（iOS `well`、Android `insetBase`、`surfaceContainerLowest`） | 凹陷底色 | 删除：凹陷用所在表面的面，`insetBase = base`（沿用 DrawerMaterial） |
| `#EEF0F5` 系（insetFocus） | iOS、Android 设置页 | 并入 `surface-*`（light） |
| `#E0E7DF` / `#33393D` | DrawerMaterial | `surface-base`（sage-light / sage-dark） |
| `#E5E7E9` / `#2C2E31` | ProviderDialScreen | 删除，跟随外观 |
| `#232A36` / `#354A3C` | ink | `ink`（sage 加深为 `#2F4235`） |
| `#4A5364` / `#6E8171` | secondary / muted | `ink-muted`（sage 加深为 `#4F6153`） |
| `alpha 0.38 / 0.45` 的墨色、整体 `opacity 0.4 / 0.6` | 禁用 | `ink-faint` + `hairline` 轮廓 |
| `#2459D3` `#5F8FE5` `#A9C0FF` | 主色（蓝） | `accent`（`#2F5287` / `#AFC6E6`） |
| `#56775B` `#A9DDC1` | 主色（灰绿） | `accent`（`#41603F` / `#A9DDC1`） |
| `#99482F` / `#F2AD90` | Pi | `agent-pi`（`#8C3870` / `#F0A9D3`） |
| `#006C64` / `#77D6C7` | Codex | `agent-codex`（浅色微调 `#00655D`） |
| `#4D6BFE` / `#A1B5FF` | DeepSeek | `agent-deepseek`（`#3550CF` / `#A9BBFF`），标记本身仍可用品牌蓝 |
| `#B4572E` / `#F0B48C` | Claude | `agent-claude`（`#9A4521` / `#F0B48C`） |
| `#1B7A57` `#278868` `#84D6B3` | 成功 | `success` |
| `#9A5B00` `#F2C26B` `#bd6320` | 警告 | `warning` |
| `#B3261E` `#a63838` `#B85A54` `#FFB4AB` | 错误 | `danger` |
| `#A6B2C6` `#0A0C11` `#BAC7B8` `#20282B` | 暗影 | `shade` |
| `#FFFFFF` `#2E323C` `#EEF2EB` `#475156` | 高光 | `highlight` |
| `#2A3344` `#203626` | 遮罩 | `scrim` + `opacity-scrim` |
| `#C9D1DE` `0x33A6B2C6` | 描边、历史树线 | `hairline` |

### 3. 尺寸、圆角、阴影

| 旧值 | 出处 | 新值 |
| --- | --- | --- |
| `RemoteUi.PagePadding 20` | Android | `space-20` |
| 卡片总左右边距 16（S30 侧栏） | Android | 抽屉内 `space-16`，页面 `space-20` |
| 标签栏 `RoundedCornerShape(19)` / 高 58 / 图标 21 | HomeTabs.kt | `radius-md` / `bar-height` 56 / `icon-md` 22 |
| 工具组 14 / 15、`OrbisTheme.small` 12、`extraSmall` 10 | ToolViews.kt、OrbisTheme | `radius-sm` 12 |
| 20 / 21 圆角 | MainActivity 首页关闭指示、转盘 | `radius-lg` 24 或 `radius-md` 16 |
| iOS `radius 14`（文字按钮、聊天内面板） | ChatView、OrbisTextButton | 按钮 `radius-md` 16 / 小按钮 `radius-sm` 12；面板 `radius-sm` |
| iOS `OrbisRadius.sheet 28` | OrbisDesign | `radius-xl` 32 |
| Host `radius 6 / 7 / 8` | Main.qml、ActionButton | 控件 `radius-md`、卡片 `radius-lg`、对话框 `radius-xl` |
| 文字按钮 Android 48 / iOS 40 / Host 42 | | 中号 `control-height` 48、小号 `control-height-sm` 40 |
| iOS 命中区 44 | NeuIconButtonStyle | `touch-target` 48 |
| 待确认操作 26 / 28 | ChatView / MainActivity | `disc-xs` 28 |
| 选择标记 22 / 24 | iOS / Android | `checkbox` 24 |
| 状态点 7、凸起高光状态点 | Host、iOS、`NeumorphStatusDot` | `dot` 8 实心 / 空心圈，占位 `dot-ring` 16；去掉凸起与高光 |
| shadowScale / intensity 12 档 | 两端 | `raised/inset-sm` 0.4、`-md` 0.65、`raised-lg` 1.0 |
| `nestedSurfaceLayer(parent, pressed)` 按下降一层、嵌套凹陷无阴影 | Neumorph.kt / OrbisDesign.swift | 按下与凹陷回到父层（同色），保留内阴影；凸起子元素仍升一层、无外阴影 |

### 4. 组件对照

| 本系统 | Android | iOS | Host |
| --- | --- | --- | --- |
| `Surface` | `NeumorphSurface` | `.neuSurface()` | `NeuSurface` |
| `Button` | `NeumorphTextButton` + `NeumorphActionButton`（合并为 `OrbisButton(variant, size)`） | `OrbisTextButton` + `NeuButtonStyle` | `ActionButton` |
| `IconButton` | `NeumorphIconButton` | `OrbisIconButton` | 新增 |
| `TextField` | `NeumorphTextField` + `neumorphInsetOverlay` | `.orbisInput()` / `.orbisField()` | 文本框样式 |
| `Checkbox` | `NeumorphCheckbox`、`OrbisSelectionIndicator` | `OrbisCheckbox`、`OrbisSelectionIndicator` | — |
| `Switch` | 新增（设置布尔项） | 新增 | `softSwitch` |
| `Segmented` | `AgentChoice`、协议模式按钮组 | 同 | — |
| `StatusDot` / `StatusPill` | `NeumorphStatusDot`、首页连接胶囊、`StatusRow` 值 | 同名视图 | 状态点 + 标签 |
| `AgentLabel` | `AgentLabel` / `AgentEmblem` / `AgentIconRecess` / `AgentTheme` | `palette.agent()` + 视图 | — |
| `Wordmark` | `OrbisWordmark` | 同 | 字标 |
| `TopBar` | `RemoteTopAppBar`、会话顶栏 | 同 | 页面标题区 |
| `TabBar` | `HomeTabBar` | 根标签 | 侧栏导航 |
| `Menu` | `NeumorphMenu` / `MotionMenu` | 菜单栈 | — |
| `Dialog` | `NeumorphDialog` | 对话框 | `DialogSurface` |
| `Sheet` | `ModalBottomSheet`（换外观） | `.sheet` | — |
| `Notice` | 通知 / 短反馈覆盖（V06） | 通知横幅（`neuSurface` + 关闭圆钮） | 消息条 |
| `Progress` | `LinearProgressIndicator`（换外观） | `ProgressView` | 下载进度条 |
| `SessionCard` | 首页 runtime 卡 | 同 | — |
| `ListGroup` | 设置分组 + `StatusRow` | 同 | 卡片列表 |
| `DirectoryGroup` | `DrawerDirectorySlice` / `DrawerBranch` | `directoryGroup` | — |
| `AssistantCard` / `ToolGroup` / `CodeBlock` | `AssistantTurnCard` / `ToolViews` / Markdown 代码块 | 同 | — |
| `UserMessage` | `UserMessageCard` + `PendingSendStatus` | 同 | — |
| `Composer` | 会话输入栏 + `ComposerSessionInfo` | 同 | — |
| `ProviderDial` | `ProviderDialScreen`（重写绘制，去私有 palette；沿用 `ProviderDialGeometry` 角度换算） | 供应商页 | — |
| `SessionDraft` | 新增（替换新建会话面板） | 新增 | — |
| `AppearancePicker` / `ThemePreview` | 新增（替换外观分段） | 新增 | 外观设置 |
| `ChoiceList` | 新增（连接协议、下一轮权限） | 新增 | — |

### 5. 图标对照（Material Symbols Rounded ↔ SF Symbols）

| 用途 | Material | SF Symbols |
| --- | --- | --- |
| 目录 | `menu` | `line.3.horizontal` |
| 返回 | `arrow_back` | `arrow.left` |
| 下载 | `download` | `arrow.down.to.line` |
| 设置 | `settings` | `gearshape` |
| 历史与分支 | `history` | `clock.arrow.circlepath` |
| 附件 | `attach_file` | `paperclip` |
| 发送 | `arrow_upward` | `arrow.up` |
| 停止 | `stop`（实心） | `stop.fill` |
| 搜索 / 筛选 / 新建 | `search` / `filter_list` / `add` | `magnifyingglass` / `line.3.horizontal.decrease` / `plus` |
| 目录 | `folder`（实心用于目录槽） | `folder.fill` |
| 展开 / 进入 | `keyboard_arrow_down` / `chevron_right` | `chevron.down` / `chevron.right` |
| 关闭 / 刷新 / 删除 / 放回输入框 | `close` / `refresh` / `delete` / `edit` | `xmark` / `arrow.clockwise` / `trash` / `pencil`（替换 iOS 现用的 `arrow.uturn.backward`，与 Android 一致） |
| 复制 / 完成 | `content_copy` / `check` | `doc.on.doc` / `checkmark` |
| 电脑 / 锁 / 权限 | `computer` / `lock` / `shield` | `laptopcomputer` / `lock.fill` / `shield` |
| 分支 / 切换 | `account_tree` / `swap_horiz` | `arrow.triangle.branch` / `arrow.left.arrow.right` |
| 聊天 / 供应商 | `chat_bubble` / `tune` | `bubble.left` / `slider.horizontal.3` |
| 成功 / 警告 / 错误 / 信息 | `check_circle` / `warning` / `error` / `info` | `checkmark.circle` / `exclamationmark.triangle` / `exclamationmark.circle` / `info.circle` |
| 工具 / 思考 | `build` / `psychology` | `wrench.and.screwdriver` / `brain` |
| 扫码 / 归档 / 更多 | `qr_code_scanner` / `archive` / `more_horiz` | `qrcode.viewfinder` / `archivebox` / `ellipsis` |

Android 从 `Icons.Rounded.*`（填充为主）迁到 Material Symbols Rounded 描线版（可变字体或 SVG 资源），与 SF Symbols 的描线气质一致；Host 的 ◈ ▣ ⌘ ⚙ ≡ ⠿ ✓ 换成对应 SVG。

### 6. 动效常量

| token | Android `InteractionMotion` | iOS `InteractionMotion` | 说明 |
| --- | --- | --- | --- |
| `dur-press` / `dur-release` | `GlyphPress 80` / `GlyphRelease 160` | `glyphPress` / `glyphRelease` | 同值；新增表面深度共用 |
| `dur-state` | `State 160` | `state` | 同值 |
| `dur-selection` | `Selection 260` | `selection` | 同值 |
| `dur-panel` | `Panel 220` | `panel` | 同值 |
| `dur-exit` / `dur-dismiss` | `Exit 160` / `Dismiss 180` | `exit` / `dismiss` | 同值；iOS `pageReturn 0.18` 并入 `dur-dismiss` |
| `dur-collapse` | `OrbisCollapse tween(260)` | `orbisCollapse` | 同值；iOS `toolbar 0.26` 并入 |
| `dur-reply-grow` / 首现 | `ReplyGrowth 180` / `ReplyArrival 220` | 同 | 同值 |
| `dur-send` | `SendTravel 280 + SendExpand 160` | `sendDuration` | 同值 |
| `hold-copy` | `CopyFeedback 2500` | 同 | 同值 |
| `dur-fade-out` / `dur-fade-in` | 新增 | 新增 | 根标签、离散文字 |
| `dur-loop` | 转盘 / 配额 1100 | 同 | 统一循环；也驱动状态点的绕行弧（原呼吸取消） |
| 弹簧 drag / page / pop | `OrbisMotion` | `orbisDrag` / `orbisSwipeBack` / `orbisPop` | 同值 |

删除：首页关闭指示的 `tween(90/100/140)`、转盘 `tween(340/460/220)`、配额 `tween(700/420)`、Host `NumberAnimation 200`；它们改用上表角色。

### 7. 建议顺序

1. 建 token 来源（四端），外观枚举，删死代码——画面应与现在的雾蓝 / 灰绿一致，只是所有页面跟随同一外观。
2. 字号与小字：转盘 8–11 → 12 / 13；Host 字号收档。
3. 尺寸与圆角收档；按钮两端合并为同一规格。
4. 深度过渡、根标签 fade-through、外观交叉淡化、对话框 / 底部面板 / 短反馈统一进出、骨架。
5. 图标迁移（Android Symbols、Host SVG）。
6. 供应商页换成双层 `ProviderDial`（去掉 Agent 横拨）。
7. 设置页重组（连接 / 外观 / 语言；删通知开关与电脑分组）；侧栏目录改单行树；新建会话改 `SessionDraft`；状态点改实心 / 空心 + 绕行弧。

每一步按根部测试规则选最小验证；视觉变化以用户安装验收为准。

## 附录 A 现状审视

依据：仓库 `7e7db06`（Android `OrbisTheme.kt` / `DrawerMaterial.kt` / `Neumorph.kt` / `RemoteUi.kt` / `InteractionMotion.kt` / `HomeTabs.kt` / `ProviderDialScreen.kt`，iOS `OrbisDesign.swift` / `InteractionMotion.swift` / `ChatView.swift`，Host `Main.qml` / `ActionButton.qml`，Relay `styles.css`），ADR-0046 / 0051 / 0054 / 0058 / 0066，`docs/design` 概念稿，以及 2026-11-05 至 11-07 的实机截图（取色）。

### 值得保留的

| 设计 | 出处 | 在新体系里的位置 |
| --- | --- | --- |
| 成对柔影 + 带色暗影（不用纯黑） | Neumorph.kt、ADR-0046 §2 | `highlight` / `shade` 与全部 `shadow` token |
| 明度台阶（base / lift / top，相邻 1–3%） | OrbisDesign.swift `OrbisPalette`、ADR-0046 | `surface-base … surface-top`，雾蓝浅色原值不变 |
| 单一材质外框、嵌套只做明度台阶（S02） | NeumorphSurface / NeuSurface | 原则 4，`flat`（只针对外阴影） |
| 凹槽与底板同色，深度只靠成对柔影 | DrawerMaterial.kt（`insetBase = base`）、侧栏目录托盘 | 原则 1：取消更深的 well 层，全 App 凹陷同色 |
| 同心圆角（子 = 父 − 内距，S03） | OrbisRadius、`concentricShape` | `radius-*` 及其用法 |
| 四档字号 20 / 15 / 13 / 12、数字等宽（S05 / S06） | OrbisTheme.kt、OrbisTextSize | `title` / `body` / `label` / `caption` |
| 图标贴字下移 0.125em（S07） | `orbisIconBaseline` | 图标规则 |
| 文件名扩展名不截断（S09） | `FileNameText` | 路径与文件名规则 |
| 用户消息凹陷、助手卡片凸起（S10） | UserMessageCard / AssistantTurnCard | `UserMessage` / `AssistantCard` |
| 输入框柔和焦点：两圈主色柔光、不改尺寸（S12） | `orbisFieldFocus` / `OrbisField` | `focus-halo` |
| 选择 = 凹陷"按进底板"（复选框、Agent 选择、根标签） | NeumorphCheckbox、AgentChoice、HomeTabBar | 原则 2，所有选中态 |
| 批量选择只改颜色不改深度（S15） | OrbisSelectionButtonStyle | `accent-soft` + 1px `accent` 轮廓 |
| 固定反馈槽（复制 ↔ 勾号、加载转圈占同一槽） | CopyFeedback、OrbisTextButton `loading` | 「交互状态」 |
| 凹刻字标（三层文字、1.8 浮雕） | OrbisWordmark.kt、Host | `Wordmark` + `engrave` |
| 状态点 + 后台同步时的动态提示（MOT-28） | NeumorphStatusDot | `StatusDot`：保留"有状态点"，呼吸改为绕行弧（11-08） |
| 两端同源的动效常量：按压 80 / 松开 160、缩放 0.94、不透明 0.82、状态 160、选择 260、面板 220、离开 160、关闭 180、折叠 260、回复增高 180 / 首现 220、发送 280 + 160、三条弹簧 | InteractionMotion.kt / .swift、OrbisMotion | `dur-*` / `ease-*` 原值 |
| 整页右滑返回、抽屉跟手、首页左滑关闭、下拉刷新回位 | SwipeBack.kt、M08–M15 | 「动效」与「布局」 |
| 供应商横拨 + 弧盘浏览的交互 | ProviderDialScreen（S32） | 保留交互，换回统一材质与字号 |

### 造成零散感的具体问题

#### 1. 同一个 App 有四套底色

实机截图取色（Android，11-05～11-07）：首页与侧栏 `#E0E7DF`（灰绿），设置页 `#EEF0F5`（雾蓝 insetFocus）且主色 `#5F8FE5`，供应商转盘 `#E5E7E9`（中性灰，`ProviderDialScreen.kt` 自带一套 `palette`），聊天页 `#E6EBF4`（经典蓝）。深色首页底部标签栏一带是 `#262931`，上方是 `#33393D`，出现一条色带。同时 iOS、Host、官网和 ADR-0046 的材质规范都是蓝系，刚定稿的图标是瓷白 + 浅雾蓝。`OrbisTheme.kt` 里整套蓝色 `LightColors` 已被 `orbisMaterialColorScheme` 覆盖，成了无人使用的死代码，注释里的圆角（16/20/28）也与实际（16/24/32）不符。

#### 2. 强调色互相冲突、部分对比度不足

- Pi `#99482F` 与 Claude `#B4572E` 色相差 4°，深色下 `#F2AD90` / `#F0B48C` 几乎相同——首页相邻两张卡分不清。
- App 主色蓝 `#2459D3` / `#5F8FE5` 与 DeepSeek `#4D6BFE` 同为饱和蓝；灰绿主色 `#56775B` 与 Codex 青 `#006C64` 同在绿青区。
- 13 号字的小字：DeepSeek `#4D6BFE` 在 `#E6EBF4` 上 3.6:1，灰绿次要文字 `#6E8171` 在 `#E0E7DF` 上 3.4:1，灰绿主色 `#56775B` 3.9:1，都不到 4.5:1。
- 语义色只在 iOS 有完整定义（success / warning），Android 在 `SessionDrawer.kt`、`TurnFileChangeViews.kt` 里各自硬写 warning `#F2C26B / #9A5B00`，Host 另有 `#278868`、`#bd6320`、`#a63838`。

#### 3. 尺寸没有档位

- Android `padding / spacedBy / size` 共出现 40 余种 dp 值：2、2.5、3、5、7、9、10、11、13、14、17、18、21、22、25、26、29…；iOS 也有 3、5、7、9、14、18。
- 圆角：Android 12 种（5、8、10、12、14、15、16、19、20、21、24、32），iOS 13 种，Host 只用 3–8。标签栏 19、工具组 14/15、转盘 21 都不在体系里。
- 阴影强度（shadowScale / intensity）出现 0.32、0.35、0.4、0.42、0.5、0.55、0.6、0.65、0.7、0.8、1.0、1.1 共 12 档，同类控件两端也不同（Android 默认 0.65，iOS 默认 0.8）。

#### 4. 同名组件两端不一样

| | Android | iOS | Host |
| --- | --- | --- | --- |
| 文字按钮高度 | 48 | 40 | 42 |
| 文字按钮字号 | 15 半粗 | 13 半粗 | 14 |
| 默认文字颜色 | `onSurface` | 主色 | 墨色 |
| 圆角 | 16 | 14 | 6 |
| 图标与文字间距 | 5 | 6 | — |
| 禁用 | 文字 0.38 / 0.45 | 整体 0.4 | 凹陷 + 0.6 |
| 图标圆钮默认颜色 | `onSurface` | `secondary` | — |
| 排队消息小操作 | 28 | 26 | — |
| 选择标记 | 24 方框 | 22 圆 | ✓ 字符 |

#### 5. 页面之间换了语言

- 供应商转盘：Impact 系压缩大写（INTEGRATIONS / OFFICIAL / PERSONAL）、8–11sp 等宽字间距小字、`✓` `↗` 文字符号、自带中性灰材质——和其他页面不是同一个产品。
- Host：Unicode 字符当导航图标（◈ ▣ ⌘ ⚙ ≡ ⠿），字号 11–33 共 12 种，圆角 6–8，标题 27–29。
- 概念稿各自带一套色板（Soft Pop 的珊瑚 / 黄 / 青 / 紫，侧栏稿的五套底色），尚未收口。
- 底部面板（`ModalBottomSheet`）和进度条（`LinearProgressIndicator`）仍是 Material 默认外观；顶栏字标写成「Easy Agents EveryWhere」。
- 选中态有两种表达：协议模式、标签栏、Agent 选择是"凹陷"，转盘页的 Agent 分段是"在凹槽里凸起"。

#### 6. 缺的或不连贯的动效

- 根标签（聊天 / 供应商 / 设置）切换是硬切（`MainActivity.kt` 直接 `when (homeTab)`）。
- 按压时表面从凸起直接跳到凹陷（`NeumorphSurface` 的 `currentStyle` 不插值），只有字形有 80/160 过渡。
- 浅深色、雾蓝 / 灰绿切换没有过渡；对话框和底部面板用平台默认进出，和锚点菜单的节奏不一致。
- 散落的私有时长：90、100、140（首页左滑关闭指示的出入，`MainActivity.kt`）、340、460（转盘）、420、700（配额）、1100（三处循环，曲线各不相同）、Host 的 200 线性宽度。
- 加载时只有转圈或 Material 进度条，没有和材质一致的占位。

### 取舍

- **保留**：上表全部；雾蓝浅色 base / lift / top 原值；动效常量原值；灰绿作为第二外观（改为对比度达标的墨色）。
- **改**：所有页面跟随同一外观；Orbis 主色降为低彩度墨蓝，色相让给 Agent；Pi 改莓紫；DeepSeek / Claude 小字加深到 ≥4.5:1；尺寸、圆角、阴影收进档位；两端同名组件用同一规格。
- **丢弃**：凹陷时加深底色（ADR-0046 与 iOS 的 well 层 `#DDE3EF` / `#1C1F26`；与已认可的侧栏「凹槽同色」冲突）；转盘页的 Impact 大写、等宽小字和私有中性灰；Host 的 Unicode 图标与 6–8 圆角；任何低于 12 的字号；整体降透明度的禁用；概念稿里的多彩点缀色；页面私有的时长与弹簧。

## 附录 B 修订记录

| 日期 | 改动 | 原因 |
| --- | --- | --- |
| 11-07 | 建立统一设计语言：雾蓝为默认材质、灰绿为第二外观、Pi 改莓紫；四个主题共用语义 token；动效常量两端同源 | 四套底色、强调色冲突、尺寸无档位（附录 A） |
| 11-07 | 凹陷不换底色，深度只靠内阴影；删除更深的 well 层 | 与已验证的侧栏「凹槽同色」冲突 |
| 11-08 | 供应商页改为双层 `ProviderDial`：里圈 Agent、外圈配置、盘外刻度文字；正中空心凹陷；`zoom` 1.6 | 保留原圆盘交互，统一材质与字号；比较 1× / 1.3× / 1.6× 后定 1.6× |
| 11-08 | 圆盘两层之间加 24px 不响应的凹槽，按区域锁定手势；Agent 层吸附、无惯性；主按钮在转动中禁用 | 防误操作：两个手势不共用一块地方 |
| 11-08 | 配额同时显示 5 小时与 7 天，≤20% 转 `danger` 并标「即将用完」 | 7 天配额此前没有显示 |
| 11-08 | 设置页只留连接 / 外观 / 语言；删「回复完成时通知」与「电脑」分组；外观用 `AppearancePicker`，连接协议用 `ChoiceList` + 应用按钮 | 能默认的不做开关；看得见的选择用看得见的控件；技术选项要有解释 |
| 11-08 | 左滑关闭以 40% 宽度为门槛，过门槛「上膛」变 `danger`「松手关闭」，不按速度判断 | 破坏性手势要有可见进度与明确翻转 |
| 11-08 | 侧栏目录改为单行树：13 号字、无卡片与托盘、`hairline` 引导线；新增「导航面」密度规则 | 原侧栏字大、两行、层层嵌套，拥挤 |
| 11-08 | 新建会话改为 `SessionDraft`：列表里升起草稿卡片，写第一句话后长成会话页；不再先建空会话 | 一步开始干活；补上"升起 / 按回""形状过渡"两条动效规则 |
| 11-08 | 状态点去掉凸起、高光与呼吸：空闲空心圈、有状态实心点、正在工作时外圈绕行弧；删除 `dur-breath`，`dot-socket` 改为 `dot-ring` | 呼吸光晕质感差、读起来怪 |
| 11-08 | 圆盘当前配置名由 `display` 28 改为 `title` 20；新增 `opacity-dim`；选中一律"按下去"不加描边；所有可点元素命中区 ≥48 | 全量自查：字号成对、间距落栅格、选中与命中区合规 |
