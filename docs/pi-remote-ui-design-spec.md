# Orbis APP UI 设计规格（AI 交接文档）

> **用途**：本文档 + 同目录导出 PNG 一起投喂给任何 AI（Claude Code / Cursor / 其他），即可按稿实现，无需能读取 `.ardot` 设计源文件。
> **设计源**：ardot 文件 `726414050015913`（新拟物版与平面版同文件，新拟物靠左、平面靠右）。
> **目标平台**：Android / Jetpack Compose，设计基准 393×852（iPhone 尺寸比例，Compose 侧按 density 缩放即可）。
> **字体**：中文 Noto Sans SC，数字/英文 Inter。

---

## 一、导出图清单（与本文件同目录 `/.workbuddy/design-export/`）

| 文件 | 内容 |
|---|---|
| `neumorph-screen1.png` | 新拟物 · 01 配对连接 |
| `neumorph-screen2.png` | 新拟物 · 02 会话列表 |
| `neumorph-screen3.png` | 新拟物 · 03 会话详情（消息流 + 输入区） |
| `neumorph-spec-panel.png` | 新拟物 · 规范面板（S1配色 / S2柔影 / S3控件 / S4图标 / S5边界 / S6材质分工 / S7消息形态） |
| `flat-screen1.png` | 平面 · 01 配对连接 |
| `flat-screen2.png` | 平面 · 02 会话列表 |
| `flat-screen3.png` | 平面 · 03 会话详情 |
| `flat-spec-panel.png` | 平面 · 规范面板 |

实现时**先看规范面板图**，再看三屏图。

---

## 二、新拟物版（Neumorphism）设计 Token

核心原理：所有表面与底板同色（#E6EBF4），靠**双向柔影**（左上白高光 + 右下暗影）制造"同材质被推起/按入"的立体感。**前提条件：表面色 = 底板色**，否则高光/暗影失去物理意义。

### 2.1 颜色

| Token | 值 | 用途 |
|---|---|---|
| `surface` | `#E6EBF4` | 底板 + 一切凸起/凹陷控件表面 |
| `highlight` | `#FFFFFF` | 左上高光影 |
| `shadowDark` | `#A6B2C6` | 右下暗影 |
| `inset` | `#DDE3EF` | 凹陷区表面（输入框、工具输出等） |
| `primary` | `#2459D3` | 主色（发送按钮、强调、链接） |
| `textPrimary` | `#232A36` | 主文字 |
| `userBubble` | `#D8E2FA` | 用户气泡（平铺材质，**不加影**） |

### 2.2 柔影配方（Compose `Neumorph.kt` 已按此实现）

```kotlin
// Raised（凸起，可交互控件默认态）
// 24 环反解 alpha（外侧；内阴影 16 环），offset / reach = 5；target = 边缘处累积 alpha
// 环数即模糊分辨率：8 环时相邻环 alpha 跳 ~0.2（白光处可见色带），24 环 <0.08 连续；
// 衰减指数 2.0（(1-u)² ≈ 高斯 erfc 剖面）
左上: dropShadow(color = White.copy(alpha = 0.9f), offset = (-5, -5), radius = 7~9)
右下: dropShadow(color = #A6B2C6.copy(alpha = 0.5f), offset = (5, 5), radius = 7~9)

// Pressed（真凹陷：本体即整个节点，无外沿留白，内阴影画在表面内侧）
左上内壁: innerShadow(#A6B2C6 alpha 0.5f, offset (4,4), radius 7~8)   // 近光内壁背光
右下内壁: innerShadow(White alpha 0.9f, offset (-4,-4), radius 7~8)   // 远光内壁受光

// 开关（凹陷槽，已调优的最终参数）
槽: innerShadow(#A6B2C6 alpha 0.5f, offset 3, radius 6) + innerShadow(White alpha 0.95f, offset -3, radius 6)
滑块: 自带重影 dropShadow((3,3), radius 6, alpha 0.6f)
```

> 实现备注（2026-09-18 修正）：早期实现把暗影 target 写成 0.90（几乎翻倍，整版又重又脏），且凹陷只是「外圈反向 + 1dp 描边」，没有真内阴影。现已改为：暗影 0.5 / 白影 0.9 与设计稿一致；凹陷改为真内阴影（每环带子 = 本体 ∖ 平移后的本体，裁进本体路径），`OutlinedTextField` 用 `Modifier.neumorphInsetOverlay(shape)` 在容器上叠内阴影。

### 2.3 S6 材质分工（三档，严格遵守）

| 档位 | 材质 | 适用元素 |
|---|---|---|
| 凸起 | 双向柔影 | **可交互控件**：按钮、开关、卡片入口、返回/发送按钮 |
| 平铺 | 无影、纯色平铺 | **内容本身**：用户气泡、徽章、助手正文文字 |
| 凹陷 | 内阴影 | **附属物**：工具输出块、思考条、输入框、开关槽 |

> 气泡为什么平铺不加影：影子属于"地面"，高光属于"图形"；#D8E2FA 与底板 #E6EBF4 不同色，套新拟物影会物理矛盾。用形状区分层级——用户气泡圆角 18、**右下角收角 6**（`bottomRightRadius = 6`），即可与助手正文明确区分。

### 2.4 S7 消息形态（最终定稿）

- **用户消息**：`#D8E2FA` 气泡，圆角 18 / 右下 6，无阴影，靠右。
- **助手回复**：**不用气泡**（与 ChatGPT / Claude 同款不对称做法，属预期行为）。用「轮次分组 + 左侧标识线」：
  - 分组容器：透明底、左内边距 17；
  - 标识线：宽约 2px 的左侧渐变色带 `#C4CCD9 → 透明`（position 0~0.016 处实色后透明），作为容器 fill 的渐变实现，**不参与布局**，高度天然贴合内容；
  - 组内子块（正文/工具输出/思考条）垂直间距 10；相邻轮次间距 24。

---

## 三、平面版（Flat）设计 Token

层级不靠影，靠**面 + 描边**三级承担：

| Token | 值 | 层级 |
|---|---|---|
| `canvas` | `#F7F9FC` | 页面底 |
| `cardSurface` | `#FFFFFF` + 1px 描边 `#E5E8EF` | 一级面：卡片、可点控件 |
| `weakSurface` | `#E9EEF6` | 二级面：弱容器（搜索框内衬、工具输出、思考条）——**与画布至少差 14 级明度**，再浅会读不出 |
| `primary` | `#2459D3` | 三级：主按钮实底、强调 |
| `textPrimary` | `#1B2028` | 主文字 |

消息形态规则同新拟物 S7（气泡/分组/标识线），仅把标识线换成描边色系。

---

## 四、屏幕结构（两版一致，仅材质不同）

1. **01 配对连接**：状态栏 → 页头 → 二维码卡片 → 手动填写表单（地址/端口）→ 弹性留白 → 连接按钮（平面版含脚注文字）。
2. **02 会话列表**：状态栏 → 标题行 → 搜索框(52) → 会话列表（新拟物版含开关等控件）→ 新建会话按钮。
3. **03 会话详情**：状态栏 → 顶栏（返回按钮 40 / 会话标题块 / 顶栏操作组）→ 消息流（弹性置底 + 用户消息行 ×2 + 助手轮次 A/B，助手轮次含正文、工具输出块、思考条）→ 输入区（附件按钮 44 / 输入框 48 / 发送按钮 48）。

---

## 五、可直接使用的常量

### Compose

```kotlin
object PiRemoteDesign {
    // 新拟物版
    val NeuSurface = Color(0xFFE6EBF4)
    val NeuHighlight = Color(0xFFFFFFFF)
    val NeuShadowDark = Color(0xFFA6B2C6)
    val NeuInset = Color(0xFFDDE3EF)
    val UserBubble = Color(0xFFD8E2FA)
    // 平面版
    val FlatCanvas = Color(0xFFF7F9FC)
    val FlatCard = Color(0xFFFFFFFF)
    val FlatWeak = Color(0xFFE9EEF6)
    val FlatStroke = Color(0xFFE5E8EF)
    // 共用
    val Primary = Color(0xFF2459D3)
    val TextNeu = Color(0xFF232A36)
    val TextFlat = Color(0xFF1B2028)

    const val BubbleRadius = 18
    const val BubbleTailRadius = 6   // 右下收角
    const val TurnSpacing = 24       // 轮次间距
    const val GroupInnerSpacing = 10 // 助手轮次组内间距
}
```

### CSS 变量（如需 Web 端复用）

```css
:root {
  --neu-surface: #E6EBF4; --neu-highlight: #FFFFFF; --neu-shadow: #A6B2C6;
  --neu-inset: #DDE3EF; --user-bubble: #D8E2FA;
  --flat-canvas: #F7F9FC; --flat-card: #FFFFFF; --flat-weak: #E9EEF6;
  --flat-stroke: #E5E8EF; --primary: #2459D3;
  --text-neu: #232A36; --text-flat: #1B2028;
}
```

---

## 六、实现优先级建议

1. 新拟物版是主方案（`Neumorph.kt` 已有基础组件：底板、Raised/Pressed、Dark 配色已定义），先对齐 S6/S7 两条新规范。
2. 平面版作为备选主题，同一套布局只换 Token。
3. 遗留未决项：是否给用户消息上方加极小时间戳（长列表锚点）——设计上未定稿，实现时可先不做。
