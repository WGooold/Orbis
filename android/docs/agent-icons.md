# Pi / Codex / DeepSeek / Claude 视觉标识

四个 agent 标志都是随 APK 打包的 Android VectorDrawable，无需网络、图片服务或额外运行时依赖。

| 后端 | 素材来源 | 本地资源 | 处理 |
| --- | --- | --- | --- |
| Pi | [Pi 官网 SVG](https://pi.dev/logo-auto.svg) | `app/src/main/res/drawable/ic_agent_pi.xml` | 保留三个原色与路径，在裁去原始画布空白后居中按 85% 显示，平衡方块轮廓相对其他 Agent 的视觉重量；iOS `AgentPi.svg` 使用等效画布留白。图标槽、底板与触控区不变。 |
| Codex | [Lobe Icons Codex SVG](https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/codex.svg) | `app/src/main/res/drawable/ic_agent_codex.xml` | 保留终端与结形轮廓、even-odd 镂空；单色按当前明暗主题染色。将 SVG 压缩的弧线标志位与坐标逐项分隔，避免 Android PathParser 把 `0 013.046` 等写法解析成错误坐标。 |
| DeepSeek Harness | [DeepSeek Harness 官方标志 SVG](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/apps/web/public/favicon.svg) | `app/src/main/res/drawable/ic_agent_dsh.xml` | 保留官方路径坐标与非零填充（鲸鱼的留白靠官方子路径定向挖出，改成 even-odd 会变实心）；只用平移裁去官方画布留白，不改造标志本体。 |
| Claude Code | [Lobe Icons Claude SVG](https://github.com/lobehub/lobe-icons/blob/f25f22c0e7295a76077fe417d23deeb56eefdf3e/packages/static-svg/icons/claude-color.svg) | `app/src/main/res/drawable/ic_agent_claude.xml` | 使用 Claude 的不规则放射标，保留原路径、非零填充与橙色 `#D97757`；将弧线标志位和坐标逐项分隔以兼容 Android PathParser。iOS 的 `AgentClaude.svg` 使用相同路径和原色。 |

四个标志的来源与权利声明放在 `app/src/main/assets/agent-icon-notices.txt`，随 APK 一并发布：Pi、Codex 与 Claude 标志来自 MIT 许可的图标源，产品名称与标志仅用于标识对应的第三方 agent；DeepSeek 鲸鱼图形是 DeepSeek 的商标，仅用于标识 Orbis 连接的 DeepSeek Harness，不表示官方背书或合作。

配对页使用通用电脑图标和「连接你的电脑」；Agent 扩展沿用会话身份标识。

`AgentBrand.kt` 集中定义图标、名称和强调色。Pi 使用暖陶色，Codex 使用青绿色；DeepSeek 使用官方品牌蓝 `#4D6BFE`，深色主题采用同色系浅色调。各主题保持文字对比和共用材质连续。

Claude 图标在两种主题中使用资源原色 `#D97757`；文字、按钮与焦点使用主题陶色。iOS `AgentEmblem` 以原色模式显示同一矢量资源。

- 在线列表、缓存侧栏、聊天标题、只读历史、新建会话选项和交互弹窗均显示明确的 agent 名称与对应标志。
- 聊天轮次显示当前 agent 图标与名称；输入占位、发送动作、输入焦点、命令选择跟随当前 agent 的强调色。
- Agent 身份使用 runtime / session catalog 的声明。
- 通用页面沿用共用主题，文件来源按原会话标识展示。
