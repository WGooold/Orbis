/**
 * 新拟物（Neumorphism）设计系统。
 *
 * 核心视觉：控件从同一块「软基色」底板上凸起（Raised），靠一对反向柔影（左上白光、右下暗影）
 * 塑形，而不是描边和海拔。
 *
 * 控件与独立内容面共用这套材质：操作凸起，输入/选中/嵌套内容凹陷。
 * 连续画布、文字、状态点、树连接线和图片本体不单独加影，避免破坏阅读与信息编码。
 * 所有平面例外及位置记录在 android/docs/neumorphism-audit.md。
 *
 * 实现说明：柔影主体用 **BlurMaskFilter 真高斯模糊**（API 28+，画笔缓存、单图层、
 * 不依赖 RenderEffect / graphicsLayer）；API < 28 无硬件加速支持，回退到纯绘制的
 * 柔影环近似（[SHADOW_RINGS] 环反解 alpha，[SHADOW_FALLOFF] 衰减）。
 *
 * 两条几何硬约束（血案，勿回退）：
 *
 * 1. **扩散距离必须 ≤ 位移**（[ShadowBlur] ≤ [ShadowOffset]）。
 *    每个柔影环是「形体放大 grow 后平移 offset」，它在**反向**一侧的越界量正是 grow - offset。
 *    一旦 reach > offset，最外几环就会绕过形体出现在对侧，而且 alpha 不低（实测 0.6~0.7）；
 *    那一片恰好落在另一侧柔影最亮的位置上，两个柔影就在形体边缘互相冲淡 ——
 *    贴边一圈既非亮也非暗（近似底色），再往外才重新见到阴影。观感就是
 *    「阴影飘在半空、控件边上有一道亮缝」。reach ≤ offset 时反向越界量恒 ≤ 0，问题消失。
 *
 * 2. **衰减必须收敛到 0**。
 *    若所有环共用一个 alpha（早期实现：a = 1-(1-target)^(1/N)），累积剖面在最外沿会留下
 *    一个 0.2~0.26 的台阶、紧接骤降为 0 —— 那就是一圈可见的硬边。改为给每环反解 alpha
 *    （[ringAlphas]），让累积结果等于一条收敛到 0 的剖面，外沿才是连续淡出的。
 *
 * 为什么不用 Modifier.blur（血案，勿回退）：
 * - blur 默认 BlurredEdgeTreatment.Rectangle，会把模糊结果**裁到节点边界**，柔影实际是切硬的；
 * - blur/alpha/graphicsLayer 每个阴影各加一层图层，一个控件十几个图层；抽屉侧滑动画期间
 *   图层反复重建、部分帧被丢弃，效果就「时隐时现」。纯绘制没有这两个问题。
 */
package dev.pi.remote

import android.graphics.BlurMaskFilter
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.pow

/** 新拟物配色：底板 + 一对阴影。 */
@Immutable
data class NeumorphColors(
    /** 底板色：所有控件与页面共用。 */
    val base: Color,
    /** 左上高光。 */
    val lightShadow: Color,
    /** 右下暗影。 */
    val darkShadow: Color,
    /** 凹下（Pressed）时的底板色，比 base 深一点。 */
    val insetBase: Color,
) {
    companion object {
        val Light = NeumorphColors(
            base = Color(0xFFE6EBF4),
            lightShadow = Color(0xFFFFFFFF),
            darkShadow = Color(0xFFA6B2C6),
            insetBase = Color(0xFFDDE3EF),
        )
        val Dark = NeumorphColors(
            base = Color(0xFF23262E),
            lightShadow = Color(0xFF2E323C),
            darkShadow = Color(0xFF0A0C11),
            insetBase = Color(0xFF1C1F26),
        )
    }
}

@Composable
fun rememberNeumorphColors(): NeumorphColors =
    if (isSystemInDarkTheme()) NeumorphColors.Dark else NeumorphColors.Light

/** 凸起 = Raised（按钮/卡片），凹下 = Pressed（输入框/内嵌面板）。 */
enum class NeumorphStyle { Raised, Pressed }

/** 柔影沿对角线的位移。 */
private val ShadowOffset: Dp = 4.dp

/**
 * 柔影的模糊半径（BlurMaskFilter 参数 / 环兜底的扩散距离）。**必须 ≤ [ShadowOffset]**
 * （环兜底的反向越界约束；真模糊的高斯尾到对侧已衰减到可忽略）。
 */
private val ShadowBlur: Dp = 4.dp

/**
 * 柔影环数——**仅 API < 28 的环近似兜底**用（BlurMaskFilter 自 API 28 起才有硬件加速支持）。
 * 环数即模糊「分辨率」：8 环时相邻环 alpha 跳 ~0.2，可见色带；24 环 <0.08 连续。
 */
private const val SHADOW_RINGS = 24

/** 内阴影环数（兜底路径）：每环是一次 Path 裁剪（比外环贵），16 环取平衡。 */
private const val SHADOW_RINGS_INNER = 16

/** 衰减曲线指数（兜底路径）：2.0 时 (1-u)² 的剖面与高斯 erfc 尾形几乎重合。 */
private const val SHADOW_FALLOFF = 2.0f

// 柔影强度：真高斯模糊下，可见边缘处的实际 alpha ≈ 画笔 alpha 的一半（高斯在形体边缘
// 正好衰减一半）。此前环近似把 target 顶在边缘（0.9/0.5 全额贴边）所以「太亮」；
// 换真模糊后按 0.70/0.38 的画笔值，边缘观感 ≈ 0.35/0.19，且尾形连续——太亮/不够模糊一起解决。
private const val ALPHA_DARK = 0.38f
private const val ALPHA_LIGHT = 0.70f

/**
 * 形状的圆角半径（柔影环按同曲率放大）。CircleShape 也是 RoundedCornerShape(50%)，
 * 走同一分支即可；矩形退化为 0。
 *
 * 注意：drawRoundRect 只接受单一圆角半径，所以**不要给 NeumorphSurface 传四角不等的形状**
 * （如聊天气泡那种 18/6/18/18）——柔影会用同一个半径，和底板对不上。四角不等的面本来
 * 就该是平铺内容，不是新拟物控件。
 */
private fun shapeCornerPx(shape: Shape, size: Size, density: Density): Float = when (shape) {
    is RoundedCornerShape -> shape.topStart.toPx(size, density)
    else -> 0f
}

/**
 * 反解每一环的 alpha，使累积结果恰好等于剖面
 * `V(k) = target * ((N-k)/N)^falloff`（k 为环序号，由内向外 1..N；V(N) = 0）。
 *
 * 环 k 覆盖「距形体边缘 offset + (k-1)*step ~ offset + k*step」这一段，累积 alpha 为
 * `1 - Π(1-a_j)`（与叠放顺序无关），于是可以逐环由外向内反解：
 * `a_k = 1 - (1-V(k-1)) / (1-V(k))`。
 */
private fun ringAlphas(
    target: Float,
    rings: Int = SHADOW_RINGS,
    falloff: Float = SHADOW_FALLOFF,
): FloatArray {
    val profile = FloatArray(rings + 1) { k ->
        target * ((rings - k).toFloat() / rings).pow(falloff)
    }
    return FloatArray(rings) { index ->
        val k = index + 1
        1f - (1f - profile[k - 1]) / (1f - profile[k])
    }
}

private val OuterDarkAlphas = ringAlphas(ALPHA_DARK)
private val OuterLightAlphas = ringAlphas(ALPHA_LIGHT)
// 内阴影的环数独立（路径裁剪更贵）；drawInnerShadow 的 step 按数组长度自适应。
private val InnerDarkAlphas = ringAlphas(ALPHA_DARK, rings = SHADOW_RINGS_INNER)
private val InnerLightAlphas = ringAlphas(ALPHA_LIGHT, rings = SHADOW_RINGS_INNER)

/**
 * 真高斯模糊的绘制画笔（仅 API 28+ 使用；BlurMaskFilter 自 28 起才有硬件加速支持）。
 * alpha 直接编进画笔色：高斯模糊下形体边缘处可见 alpha ≈ 画笔值的一半。
 * 每个 Composable 记住一份，避免每帧分配 Paint/BlurMaskFilter。
 */
private class ShadowPaints(colors: NeumorphColors, blurPx: Float) {
    val dark = android.graphics.Paint().apply {
        isAntiAlias = true
        color = colors.darkShadow.copy(alpha = ALPHA_DARK).toArgb()
        maskFilter = BlurMaskFilter(blurPx, BlurMaskFilter.Blur.NORMAL)
    }
    val light = android.graphics.Paint().apply {
        isAntiAlias = true
        color = colors.lightShadow.copy(alpha = ALPHA_LIGHT).toArgb()
        maskFilter = BlurMaskFilter(blurPx, BlurMaskFilter.Blur.NORMAL)
    }
}

@Composable
private fun rememberShadowPaints(colors: NeumorphColors, shadowScale: Float): ShadowPaints {
    val blurPx = with(LocalDensity.current) { ShadowBlur.toPx() * shadowScale }
    return remember(colors, blurPx) { ShadowPaints(colors, blurPx) }
}

/**
 * 画一侧柔影：由外向内叠 [SHADOW_RINGS] 个同形、逐级放大的半透明形状。
 * 每环 alpha 由 [ringAlphas] 反解，累积出连续收敛到 0 的剖面。纯绘制，不产生任何额外图层。
 */
private fun DrawScope.drawSoftShadow(
    shape: Shape,
    bodySize: Size,
    inset: Float,
    direction: Float,
    color: Color,
    offsetPx: Float,
    reachPx: Float,
    alphas: FloatArray,
) {
    val corner = shapeCornerPx(shape, bodySize, this)
    val shift = offsetPx * direction
    val step = reachPx / alphas.size
    for (ring in alphas.size downTo 1) {
        val grow = step * ring
        drawRoundRect(
            color = color.copy(alpha = alphas[ring - 1]),
            topLeft = Offset(inset + shift - grow, inset + shift - grow),
            size = Size(bodySize.width + grow * 2f, bodySize.height + grow * 2f),
            cornerRadius = CornerRadius(corner + grow, corner + grow),
        )
    }
}

/**
 * 画一侧**内阴影**（真凹陷）：每一环的带子 = 本体 ∖ 沿 shadow 方向平移 m 后的本体，
 * 全部裁进本体路径里，所以只出现在表面内侧。
 * direction=+1 → 带子贴**左上内壁**（暗影）；-1 → 贴**右下内壁**（白光）。
 * 物理模型：凹坑被按进面板，光从左上来——近光的左上内壁背光（暗），远光的右下内壁受光（亮）。
 * 带深 offset+reach，由边缘向内逐环衰减，剖面与外侧柔影同族（[ringAlphas] 语义一致：
 * 环 k 覆盖深度 [0, offset+k·step)，越靠边累积越强，边缘达到 target）。
 */
private fun DrawScope.drawInnerShadow(
    shape: Shape,
    bodySize: Size,
    color: Color,
    direction: Float,
    offsetPx: Float,
    reachPx: Float,
    alphas: FloatArray,
) {
    val corner = shapeCornerPx(shape, bodySize, this)
    val body = Path().apply {
        addRoundRect(RoundRect(0f, 0f, bodySize.width, bodySize.height, CornerRadius(corner, corner)))
    }
    clipPath(body) {
        val step = reachPx / alphas.size
        for (ring in alphas.size downTo 1) {
            val m = offsetPx + step * ring
            val shifted = Path().apply {
                addRoundRect(
                    RoundRect(
                        direction * m,
                        direction * m,
                        direction * m + bodySize.width,
                        direction * m + bodySize.height,
                        CornerRadius(corner, corner),
                    ),
                )
            }
            drawPath(
                Path.combine(PathOperation.Difference, body, shifted),
                color.copy(alpha = alphas[ring - 1]),
            )
        }
    }
}

/** 画一侧**真高斯模糊**的外柔影（API 28+）：形体平移后用 BlurMaskFilter 模糊。 */
private fun DrawScope.drawOuterBlur(
    paint: android.graphics.Paint,
    bodySize: Size,
    inset: Float,
    direction: Float,
    offsetPx: Float,
    corner: Float,
) {
    val shift = offsetPx * direction
    val left = inset + shift
    val top = inset + shift
    drawIntoCanvas { canvas ->
        canvas.nativeCanvas.drawRoundRect(
            left, top, left + bodySize.width, top + bodySize.height,
            corner, corner, paint,
        )
    }
}

/**
 * 每个绘制节点持有自己的内阴影路径，尺寸或几何变化时才重建。
 * 每帧新建同形 Path 会让渲染器不断生成新的掩码；真机六张卡片重绘曾积累约 600 MiB 图形资源。
 */
private class InnerBlurPaths(
    private val bodySize: Size,
    private val offsetPx: Float,
    private val corner: Float,
    blurPx: Float,
) {
    val body = Path().apply {
        addRoundRect(RoundRect(0f, 0f, bodySize.width, bodySize.height, CornerRadius(corner, corner)))
    }
    private val spread = offsetPx + blurPx * 4f

    private fun inverse(direction: Float) = Path().apply {
        fillType = androidx.compose.ui.graphics.PathFillType.EvenOdd
        addRect(Rect(-spread, -spread, bodySize.width + spread, bodySize.height + spread))
        addRoundRect(
            RoundRect(
                direction * offsetPx,
                direction * offsetPx,
                direction * offsetPx + bodySize.width,
                direction * offsetPx + bodySize.height,
                CornerRadius(corner, corner),
            ),
        )
    }

    val dark = inverse(1f)
    val light = inverse(-1f)
}

/** 把「大矩形 ∖ 平移后的本体」模糊后裁进本体内，保留左上暗、右下亮的凹陷造型。 */
private fun DrawScope.drawInnerBlur(paths: InnerBlurPaths, paints: ShadowPaints) {
    clipPath(paths.body) {
        drawIntoCanvas { canvas ->
            canvas.nativeCanvas.drawPath(paths.dark.asAndroidPath(), paints.dark)
            canvas.nativeCanvas.drawPath(paths.light.asAndroidPath(), paints.light)
        }
    }
}

/** 阴影绘制在可见底板外，不参与测量；凸起、凹陷与禁用态始终占据相同尺寸。 */
@Composable
private fun Modifier.neumorphShadows(
    shape: Shape,
    style: NeumorphStyle,
    colors: NeumorphColors,
    shadowScale: Float,
    paints: ShadowPaints,
): Modifier = then(remember(shape, style, colors, shadowScale, paints) {
    // 保持缓存构建器跨内容重组稳定；drawWithCache 负责在尺寸、密度等变化时重新构建。
    Modifier.drawWithCache {
        val bodySize = size
        val offsetPx = ShadowOffset.toPx() * shadowScale
        val reachPx = ShadowBlur.toPx() * shadowScale
        val corner = shapeCornerPx(shape, bodySize, this)
        val useGaussian = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        val innerPaths = if (style == NeumorphStyle.Pressed && useGaussian) {
            InnerBlurPaths(bodySize, offsetPx, corner, ShadowBlur.toPx())
        } else null
        onDrawBehind {
            if (bodySize.width <= 0f || bodySize.height <= 0f) return@onDrawBehind
            if (style == NeumorphStyle.Raised) {
                // 暗影先画，白光压在其上（对侧重叠仅高斯尾，可忽略）。
                if (useGaussian) {
                    drawOuterBlur(paints.dark, bodySize, 0f, 1f, offsetPx, corner)
                    drawOuterBlur(paints.light, bodySize, 0f, -1f, offsetPx, corner)
                } else {
                    drawSoftShadow(shape, bodySize, 0f, 1f, colors.darkShadow, offsetPx, reachPx, OuterDarkAlphas)
                    drawSoftShadow(shape, bodySize, 0f, -1f, colors.lightShadow, offsetPx, reachPx, OuterLightAlphas)
                }
            } else if (innerPaths != null) {
                drawInnerBlur(innerPaths, paints)
            } else {
                drawInnerShadow(shape, bodySize, colors.darkShadow, 1f, offsetPx, reachPx, InnerDarkAlphas)
                drawInnerShadow(shape, bodySize, colors.lightShadow, -1f, offsetPx, reachPx, InnerLightAlphas)
            }
        }
    }
})

/**
 * 新拟物底座。[modifier] 的尺寸就是可见底板的尺寸，柔影不侵占内容或改变布局。
 * 父布局在页面边缘保留至少 8dp 空间，避免滚动容器裁掉外影。
 * 内容按自身尺寸测量；只有调用者给出固定尺寸时才传递最小约束，不能使用 fillMaxSize
 * 填满任意有界父容器（例如弹窗、底部面板）。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun NeumorphSurface(
    modifier: Modifier = Modifier,
    shape: Shape = RemoteUi.CardShape,
    style: NeumorphStyle = NeumorphStyle.Raised,
    shadowScale: Float = 0.65f,
    onClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    onLongClick: (() -> Unit)? = null,
    interactionSource: MutableInteractionSource = remember { MutableInteractionSource() },
    content: @Composable () -> Unit,
) {
    val colors = rememberNeumorphColors()
    val paints = rememberShadowPaints(colors, shadowScale)
    val pressed by interactionSource.collectIsPressedAsState()
    val currentStyle = if (pressed && enabled) NeumorphStyle.Pressed else style
    val bodyColor = if (currentStyle == NeumorphStyle.Pressed) colors.insetBase else colors.base
    // 凹陷阴影须画在底色之上；外阴影须在 clip 之外。两种状态共用同一块底板。
    Box(
        modifier.then(
            if (currentStyle == NeumorphStyle.Raised) {
                Modifier.neumorphShadows(shape, currentStyle, colors, shadowScale, paints)
            } else Modifier,
        ),
        propagateMinConstraints = true,
    ) {
        Box(
            Modifier.clip(shape).background(bodyColor).then(
                if (currentStyle == NeumorphStyle.Pressed) {
                    Modifier.neumorphShadows(shape, currentStyle, colors, shadowScale, paints)
                } else Modifier,
            ).then(
                if (onClick != null) Modifier.combinedClickable(
                    interactionSource = interactionSource,
                    indication = null,
                    enabled = enabled,
                    role = Role.Button,
                    onLongClick = onLongClick,
                    onClick = onClick,
                ) else Modifier,
            ),
            propagateMinConstraints = true,
        ) {
            CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onSurface) {
                content()
            }
        }
    }
}

/** Native menu/sheet containers keep their layout and semantics while sharing our outer shadows. */
@Composable
internal fun Modifier.neumorphRaised(shape: Shape, shadowScale: Float = 0.65f): Modifier {
    val colors = rememberNeumorphColors()
    return neumorphShadows(shape, NeumorphStyle.Raised, colors, shadowScale, rememberShadowPaints(colors, shadowScale))
}

/** 小控件用更浅的柔影，避免相邻按钮的阴影连成一片。 */
private fun compactShadowScale(size: Dp): Float = (size.value / 64f).coerceIn(0.45f, 1f)

/** 新拟物图标按钮（圆形凸起；[style] 传 Pressed 可做开关的「已按下」态）。 */
@Composable
fun NeumorphIconButton(
    onClick: () -> Unit,
    icon: ImageVector,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: Shape = CircleShape,
    /** **可见**圆钮的直径。柔影画在它外面的留白里，不占这个直径。 */
    size: Dp = RemoteUi.IconButtonSize,
    /** 图标染色；null = onSurface。 */
    tint: Color? = null,
    style: NeumorphStyle = NeumorphStyle.Raised,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    Box(
        modifier
            .sizeIn(minWidth = RemoteUi.TouchTarget, minHeight = RemoteUi.TouchTarget)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        NeumorphSurface(
            modifier = Modifier.size(size),
            shape = shape,
            style = if (pressed) NeumorphStyle.Pressed else style,
            shadowScale = compactShadowScale(size) * 0.8f,
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Icon(
                    icon,
                    contentDescription = contentDescription,
                    tint = (tint ?: MaterialTheme.colorScheme.onSurface).let {
                        if (enabled) it else it.copy(alpha = 0.38f)
                    },
                    modifier = Modifier.size(RemoteUi.IconSize),
                )
            }
        }
    }
}

/** Full-width action control with the same raised language as icon buttons. */
@Composable
fun NeumorphActionButton(
    onClick: () -> Unit,
    text: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    style: NeumorphStyle = NeumorphStyle.Raised,
) {
    val contentColor = if (enabled) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f)
    }
    NeumorphSurface(
        modifier = modifier.heightIn(min = RemoteUi.FieldHeight),
        shape = RemoteUi.ControlShape,
        style = style,
        shadowScale = 0.7f,
        onClick = onClick,
        enabled = enabled,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Row(
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                icon?.let {
                    Icon(it, contentDescription = null, tint = contentColor, modifier = Modifier.size(RemoteUi.IconSize))
                    Spacer(Modifier.width(8.dp))
                }
                Text(
                    text,
                    color = contentColor,
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}

/**
 * 新拟物输入框配色：凹槽底色配轻描边，焦点用主色描边明确提示。
 * 配合 [neumorphInsetOverlay]（内阴影）使用（shape 建议传 RoundedCornerShape(16.dp)）。
 */
@Composable
fun neumorphFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedContainerColor = rememberNeumorphColors().insetBase,
    unfocusedContainerColor = rememberNeumorphColors().insetBase,
    disabledContainerColor = rememberNeumorphColors().insetBase,
    errorContainerColor = rememberNeumorphColors().insetBase,
    focusedBorderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.65f),
    unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f),
    disabledBorderColor = Color.Transparent,
    focusedTextColor = MaterialTheme.colorScheme.onSurface,
    unfocusedTextColor = MaterialTheme.colorScheme.onSurface,
)

/**
 * 给「平铺凹陷面」叠一对内阴影（在内容**之上**绘制，本体即整个节点）。
 * 用于不便换成 [NeumorphSurface] 的场合，例如 OutlinedTextField（它的容器由
 * TextField 自己绘制，外面套底座会套娃）：容器色由 [neumorphFieldColors] 给出，
 * 这里只补 S6 要求的内阴影造型。shape 须与容器的 shape 一致。
 */
@Composable
fun Modifier.neumorphInsetOverlay(shape: Shape): Modifier {
    val colors = rememberNeumorphColors()
    val paints = rememberShadowPaints(colors, 1f)
    return then(remember(shape, colors, paints) {
        Modifier.drawWithCache {
            val bodySize = size
            val offsetPx = ShadowOffset.toPx()
            val reachPx = ShadowBlur.toPx()
            val corner = shapeCornerPx(shape, bodySize, this)
            val paths = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                InnerBlurPaths(bodySize, offsetPx, corner, reachPx)
            } else null
            onDrawWithContent {
                drawContent()
                if (bodySize.width <= 0f || bodySize.height <= 0f) return@onDrawWithContent
                if (paths != null) {
                    drawInnerBlur(paths, paints)
                } else {
                    drawInnerShadow(shape, bodySize, colors.darkShadow, 1f, offsetPx, reachPx, InnerDarkAlphas)
                    drawInnerShadow(shape, bodySize, colors.lightShadow, -1f, offsetPx, reachPx, InnerLightAlphas)
                }
            }
        }
    })
}

/**
 * 新拟物文字按钮：最小触控高度 48dp，文字放大时随内容增高。
 * [danger] = 破坏性操作（删除/取消配对），文字用 error 色。
 */
@Composable
fun NeumorphTextButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    danger: Boolean = false,
    filled: Boolean = false,
    icon: ImageVector? = null,
) {
    val contentColor = when {
        !enabled -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f)
        danger -> MaterialTheme.colorScheme.error
        filled -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurface
    }
    NeumorphSurface(
        modifier = modifier.heightIn(min = RemoteUi.TouchTarget),
        shape = RemoteUi.ControlShape,
        shadowScale = 0.5f,
        onClick = onClick,
        enabled = enabled,
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            icon?.let {
                Icon(it, contentDescription = null, tint = contentColor, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(5.dp))
            }
            Text(text, color = contentColor, style = MaterialTheme.typography.labelLarge)
        }
    }
}

/**
 * 新拟物 Checkbox：24dp 方块、48dp 触控区；勾选 = 凹陷 + 主色对勾
 * （「按进底板固定」的隐喻，与 AgentChoice 的选中语言一致）。
 */
@Composable
fun NeumorphCheckbox(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val interaction = remember { MutableInteractionSource() }
    val checkColor = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f)
    Box(
        modifier.size(RemoteUi.TouchTarget).then(
            if (onCheckedChange != null) Modifier.toggleable(
                value = checked,
                enabled = enabled,
                role = Role.Checkbox,
                interactionSource = interaction,
                indication = null,
                onValueChange = onCheckedChange,
            ) else Modifier,
        ),
        contentAlignment = Alignment.Center,
    ) {
        NeumorphSurface(
            modifier = Modifier.size(24.dp),
            interactionSource = interaction,
            enabled = enabled,
            shape = RoundedCornerShape(8.dp),
            style = if (checked) NeumorphStyle.Pressed else NeumorphStyle.Raised,
            shadowScale = 0.42f,
        ) {
            if (checked) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Rounded.Check,
                        contentDescription = null,
                        tint = checkColor,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }
    }
}
