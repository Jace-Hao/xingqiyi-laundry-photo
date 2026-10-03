package com.xingqiyi.laundryphoto.ui.scan

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.unit.dp

/**
 * 扫码取景框：四周压暗遮罩 + 四角标记 + 循环扫描线。
 *
 * ## 为什么遮罩用「四块矩形」而不是 BlendMode.Clear 挖洞
 * Clear 混合模式必须在 layer 里才生效，而相机预览是下层的一个独立 View，
 * 一旦开 layer 就会多一次全屏离屏合成，低端机上直接掉帧。
 * 画上下左右四块半透明矩形围出一个洞，效果一样且零合成开销。
 *
 * ## 四角标记的作用不只是好看
 * 现场是挂满衣服的暗环境，一条细边框很容易和背景糊在一起，
 * 而四个实心直角能明确告诉店员「识别范围是这一块」——
 * 条码没放进这个框里，就真的不会被记到当前衣物上。
 */
@Composable
fun ScannerOverlay(
    modifier: Modifier = Modifier,
    /** 框宽占屏宽的比例 */
    frameWidthRatio: Float = DEFAULT_FRAME_WIDTH_RATIO,
    /** 框高 / 框宽 */
    frameAspect: Float = DEFAULT_FRAME_ASPECT,
    /** 是否显示扫描线：命中结果后应停止动画，避免用户以为还在扫 */
    running: Boolean = true,
    /** 命中后的高亮色；未命中用默认色 */
    accent: Color = DEFAULT_ACCENT
) {
    // 扫描线在框内上下循环。命中后由调用方把 running 置 false：
    // 这里只停止绘制（动画值本身仍在推进，但读取发生在 draw 阶段，不会触发重组）
    val progress by rememberInfiniteTransition(label = "scanline").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1800),
            repeatMode = RepeatMode.Restart
        ),
        label = "scanline"
    )

    Canvas(modifier = modifier.fillMaxSize()) {
        val w = size.width
        val h = size.height

        val frameW = w * frameWidthRatio
        val frameH = frameW * frameAspect
        val left = (w - frameW) / 2f
        // 略微偏上：给底部提示与按钮留出空间，也更贴近人持机时的自然视线
        val top = (h - frameH) * 0.42f

        // ---------- 遮罩：上下左右四块 ----------
        val dim = Color.Black.copy(alpha = 0.55f)
        drawRect(color = dim, topLeft = Offset(0f, 0f), size = Size(w, top))
        drawRect(
            color = dim,
            topLeft = Offset(0f, top + frameH),
            size = Size(w, h - top - frameH)
        )
        drawRect(color = dim, topLeft = Offset(0f, top), size = Size(left, frameH))
        drawRect(
            color = dim,
            topLeft = Offset(left + frameW, top),
            size = Size(w - left - frameW, frameH)
        )

        // ---------- 四角标记 ----------
        val corner = frameW * 0.09f
        val stroke = 3.5.dp.toPx()
        val right = left + frameW
        val bottom = top + frameH

        // 左上
        drawLine(accent, Offset(left, top + corner), Offset(left, top), stroke, StrokeCap.Square)
        drawLine(accent, Offset(left, top), Offset(left + corner, top), stroke, StrokeCap.Square)
        // 右上
        drawLine(accent, Offset(right - corner, top), Offset(right, top), stroke, StrokeCap.Square)
        drawLine(accent, Offset(right, top), Offset(right, top + corner), stroke, StrokeCap.Square)
        // 左下
        drawLine(accent, Offset(left, bottom - corner), Offset(left, bottom), stroke, StrokeCap.Square)
        drawLine(accent, Offset(left, bottom), Offset(left + corner, bottom), stroke, StrokeCap.Square)
        // 右下
        drawLine(accent, Offset(right - corner, bottom), Offset(right, bottom), stroke, StrokeCap.Square)
        drawLine(accent, Offset(right, bottom), Offset(right, bottom - corner), stroke, StrokeCap.Square)

        // ---------- 扫描线 ----------
        if (running) {
            val y = top + frameH * progress
            drawLine(
                brush = Brush.horizontalGradient(
                    colors = listOf(accent.copy(alpha = 0f), accent, accent.copy(alpha = 0f)),
                    startX = left,
                    endX = right
                ),
                start = Offset(left + stroke, y),
                end = Offset(right - stroke, y),
                strokeWidth = 2.5.dp.toPx()
            )
        }
    }
}

/** 取景框强调色。命中结果后扫描页会换成成功色，这里保留默认值供外部对齐 */
internal val DEFAULT_ACCENT = Color(0xFF2FD8A6)

/** 框宽占屏宽的比例 */
const val DEFAULT_FRAME_WIDTH_RATIO = 0.78f

/** 框高 / 框宽 */
const val DEFAULT_FRAME_ASPECT = 0.62f
