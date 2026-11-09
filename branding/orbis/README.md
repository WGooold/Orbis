# Orbis 品牌资源

品牌名：Orbis。Slogan：Easy Agents Everywhere。

开口方环象征稳定的基地，右上小方块象征可以独立出发的能力。当前应用图标为瓷白反色版：暖瓷白底面从左上 #FBFBF9 到右下 #E4E6EA 在 OKLab 中过渡，方环与小方块均为墨蓝 #151E33，墨色随左上光向轻微压暗，并带墨色调的贴边与环境两层柔和投影。标志按 B 版母图的形状遮罩重绘并平滑轮廓，1024px 下边缘无阶梯与亮边。底面与标志分别由 `build_icons.py` 的 `SURFACE` 与 `MARK` 参数合成，带固定种子抖动，避免 8 位渐变出现色带。

应用内配对页、网站与托盘使用的透明标记保持瓷白标志（接触阴影保留 `SHADOW_KEEP` 的 45%），在浅色与深色界面里都清晰可见。

## 文件与用途

| 文件 | 用途 |
| --- | --- |
| `master/orbis-app-1024.png` | 1024×1024、不透明、无预制圆角的图标母版 |
| `master/orbis-symbol-transparent-2048.png` | 2048×2048 透明瓷白符号，供网站、托盘与窗口使用；材质来自生成母稿，放大不代表增加原始细节 |
| `master/orbis-symbol-mono.svg` | 可缩放的单色轮廓，适合印刷、品牌与纯色场景 |
| `store/google-play-512.png` | Google Play 图标，512×512 PNG、不透明、无文字/圆角 |
| `store/app-store-1024.png` | iOS 商店图标，1024×1024、不透明；与 iOS 工程内 AppIcon 相同 |
| `android/adaptive-foreground-1080.png` | Android 自适应前景，墨蓝标志，透明背景，108dp 画布的 10× 素材 |
| `android/adaptive-background-1080.png` | Android 自适应背景，瓷白渐变；中央 72dp 与方形母版的光照一致，外圈 18dp 延续渐变 |
| `android/res/` | 可直接放入 Android 项目的完整资源目录 |
| `preview.png` | 真实母稿缩放的裁切、尺寸与单色预览 |
| `geometry.json` | 间隙、安全区域等实际导出参数 |
| `source-generated.png` | gpt-image-2 生成的 B 版母图 |
| `build_icons.py` | 可复现的前景提取、轮廓、平台缩放和资源导出脚本 |
| `build_macos_icon.swift` | 在 macOS 上从图标母版导出带圆角底板与柔和投影的应用 PNG 和完整尺寸 ICNS |

## 品牌字标


## Android 资源

- API 26+：`mipmap-anydpi-v26/ic_launcher.xml` 与圆形入口，独立前景/背景，由系统决定裁切形状。
- API 33+：`mipmap-anydpi-v33/` 增加 monochrome 层，支持系统主题图标。
- 兼容 PNG：mdpi / hdpi / xhdpi / xxhdpi / xxxhdpi，分别为 48 / 72 / 96 / 144 / 192px，含圆角和圆形版。
- 通知栏：`drawable/ic_stat_orbis.xml`，24dp 白色透明轮廓，系统负责着色。
- 启动图标前景：`drawable-nodpi/orbis_launcher_foreground.png`，墨蓝标志，432×432。
- 启动图标背景：`drawable-nodpi/orbis_launcher_background.png`，瓷白渐变，432×432。
- 应用内标记：`drawable-nodpi/orbis_mark.png`，瓷白标志，432×432，用于配对页凹槽，与 iOS `OrbisMark` 相同。

整套已接入仓库 Android 启动图标和通知小图标。

## 几何与使用规范

- 应用图标按 B 版母图的形状遮罩重绘墨色标志，合成瓷白底面；透明瓷白标记沿用母图提取的主体与贴边阴影；两者共享形状与自适应安全区，导出参数见 `geometry.json`。
- 各平台使用对应的原始导出素材，裁切与主题效果交由平台处理。
- 单色轮廓与彩色版本共享形状；彩色材质来自栅格母稿，SVG 提供单色轮廓。

## 重新导出

在仓库根目录运行 Python：

```powershell
python -m pip install pillow numpy scipy
python branding/orbis/build_icons.py
```

脚本重新写入品牌母稿、商店图标、iOS 与 Relay 图标、Host 的 PNG/ICO、Android 资源及应用内标记。

macOS Host 的访达、启动台和 Dock 使用带圆角底板的应用图标；菜单栏和窗口内使用透明符号。在 macOS 上重新导出 ICNS 与圆角 Host 图标：

```sh
swift branding/orbis/build_macos_icon.swift
```

输出位于 `packages/windows-host/src/assets/orbis-macos.png` 和 `orbis.icns`。CMake 将 ICNS 放入应用包并写入 `CFBundleIconFile`，运行时使用同版 PNG。
