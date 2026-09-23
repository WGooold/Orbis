# Orbis 品牌资源

品牌名：Orbis。Slogan：Easy Agents Everywhere。

开口方环象征稳定的基地，右上小方块象征可以独立出发的能力。定版强化小方块与主体的距离，保持冷静、轻盈的新拟物气质。所有尺寸由同一母稿导出，不单独生成小图。

## 文件与用途

| 文件 | 用途 |
| --- | --- |
| `master/orbis-app-1024.png` | 1024×1024、不透明、无预制圆角的图标母版 |
| `master/orbis-symbol-transparent-2048.png` | 2048×2048 透明彩色符号；材质来自生成母稿，放大不代表增加原始细节 |
| `master/orbis-symbol-mono.svg` | 可缩放的单色轮廓，适合印刷、品牌与纯色场景 |
| `store/google-play-512.png` | Google Play 图标，512×512 PNG、不透明、无文字/圆角 |
| `store/app-store-1024.png` | 预留 iOS 商店图标，1024×1024、不透明；不包含 iOS 工程接入 |
| `android/adaptive-foreground-1080.png` | Android 自适应前景，透明背景，108dp 画布的 10× 素材 |
| `android/adaptive-background-1080.png` | Android 自适应背景，纯色 #10213D |
| `android/res/` | 可直接放入 Android 项目的完整资源目录 |
| `preview.png` | 真实母稿缩放的裁切、尺寸与单色预览 |
| `geometry.json` | 间隙、安全区域等实际导出参数 |
| `source-generated.png` | gpt-image-2 生成的材质源图 |
| `build_icons.py` | 可复现的提取、轮廓、缩放和资源导出脚本 |

## 品牌字标


## Android 资源

- API 26+：`mipmap-anydpi-v26/ic_launcher.xml` 与圆形入口，独立前景/背景，由系统决定裁切形状。
- API 33+：`mipmap-anydpi-v33/` 增加 monochrome 层，支持系统主题图标。
- 兼容 PNG：mdpi / hdpi / xhdpi / xxhdpi / xxxhdpi，分别为 48 / 72 / 96 / 144 / 192px，含圆角和圆形版。
- 通知栏：`drawable/ic_stat_orbis.xml`，24dp 白色透明轮廓，系统负责着色。
- 材质前景：`drawable-nodpi/orbis_launcher_foreground.png`，432×432。

整套已接入仓库 Android 启动图标和通知小图标。应用名称、包名和版本号不在这次图标修改范围内。

## 几何与使用规范

- 小方块和方环是两个独立部分；不要拉近或合并。间隙约为小方块等效边长的 0.99 倍。
- 自适应画布 108dp，主要图形位于中心半径 31.5dp 内，留在 Android 保证可见的 33dp 安全圆内。
- 可见视口按中心 72dp 导出商店与兼容图标；小图和大图间距一致。
- 不要把预览中的底板、文字、阴影整体截图当图标；商店素材不预制圆角。
- 单色轮廓与彩色版本共享形状。主题预览颜色仅示意，实际由系统壁纸主题决定。
- 彩色版本的渐变来自栅格母稿；SVG 是单色轮廓，不声称是可编辑的彩色材质矢量。

## 重新导出

在仓库根目录运行 Windows Python：

```powershell
python -m pip install pillow numpy scipy
python branding/orbis/build_icons.py
```

脚本会重新写入本套图标和 `android/app/src/main/res/` 对应的 Orbis 图标资源。不要用它覆盖其他任务正在编辑的图标。
