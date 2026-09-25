# Pi / Codex / DeepSeek 视觉标识

Pi 和 Codex 标志都是随 APK 打包的 Android VectorDrawable，无需网络、图片服务或额外运行时依赖。DeepSeek 使用仓库内的 Orbis 几何字标，不引入第三方素材。

| 后端 | 素材来源 | 本地资源 | 处理 |
| --- | --- | --- | --- |
| Pi | [Pi 官网 SVG](https://pi.dev/logo-auto.svg) | `app/src/main/res/drawable/ic_agent_pi.xml` | 保留三个原色与路径，平移画布裁去外围空白；没有改造标志本体。 |
| Codex | [Lobe Icons Codex SVG](https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/codex.svg) | `app/src/main/res/drawable/ic_agent_codex.xml` | 保留终端与结形轮廓、even-odd 镂空；单色按当前明暗主题染色。将 SVG 压缩的弧线标志位与坐标逐项分隔，避免 Android PathParser 把 `0 013.046` 等写法解析成错误坐标。 |
| DeepSeek Harness | Orbis 自有几何字标 | `app/src/main/res/drawable/ic_agent_dsh.xml` | 不使用第三方品牌素材，按当前明暗主题使用 Orbis 蓝色强调。 |

Pi 和 Codex 的第三方来源版权声明放在 `app/src/main/assets/agent-icon-notices.txt`，随 APK 一并发布。DeepSeek 图形为 Orbis 自有资源，不需要额外第三方声明。

配对页使用通用电脑图标和「连接你的电脑」，不强调支持的 agent 数量。后续新增 agent 时延伸会话标识即可，不需要改动配对概念。

`AgentBrand.kt` 集中定义图标、名称和强调色。Pi 使用暖陶色，Codex 使用青绿色，DeepSeek 使用蓝色；这些是 Orbis 的界面配色，不宣称是官方品牌规范。浅色/深色分别提供对比清晰的文字色。页面底板不随 agent 换色，保持新拟物材质连续。

- 在线列表、缓存侧栏、聊天标题、只读历史、新建会话选项、会话别名和交互弹窗均显示明确的 agent 名称与对应标志。
- 聊天轮次显示当前 agent 图标与名称；输入占位、发送动作、输入焦点、命令选择跟随当前 agent 的强调色。
- Agent 身份取自 runtime / session catalog，不根据模型供应商推断。Pi 选择 OpenAI 模型仍显示 Pi。
- 通用设置、主机连接和下载管理不冒用某个 agent 的页面主题；文件来源仍按原会话标识展示。
