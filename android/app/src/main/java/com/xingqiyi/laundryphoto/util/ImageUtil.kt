package com.xingqiyi.laundryphoto.util

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileOutputStream

/**
 * 照片处理：采样解码 → 方向纠正 → 压缩 → 水印 → 落盘。
 *
 * 移动端与桌面端的差异在于「不能把原图直接上传」：
 * 手机摄像头动辄 4000×3000、5~10MB，在局域网弱网下 base64 上传极易超时，
 * 服务端磁盘也会很快被吃满。因此统一在端上压到长边 [DEFAULT_MAX_DIMENSION]、
 * 质量 82，并叠加与桌面端一致的时间水印（水印是存档凭证的一部分，不能丢）。
 */
object ImageUtil {

    /** 默认长边像素：足够看清衣物细节，又能把单张控制在 1MB 上下 */
    const val DEFAULT_MAX_DIMENSION = 1920

    /**
     * 处理一张拍摄得到的照片。
     *
     * @param srcPath 相机输出的临时文件
     * @param outFile 处理后的目标文件（调用方决定放在缓存还是离线目录）
     * @param watermark 水印文案（拍摄时间）
     * @return 成功返回 [outFile]，失败返回 null
     */
    fun processCapture(
        srcPath: String,
        outFile: File,
        watermark: String,
        maxDimension: Int = DEFAULT_MAX_DIMENSION,
        quality: Int = 82
    ): File? {
        val decoded = decodeWithOrientation(srcPath, maxDimension) ?: return null
        val scaled = scaleToMax(decoded, maxDimension)
        val marked = drawWatermark(scaled, watermark)
        return if (writeJpeg(marked, outFile, quality)) outFile else null
    }

    /**
     * 解码并按 EXIF 方向纠正。
     *
     * 手机拍照普遍把方向记在 EXIF 里而不是真的旋转像素，
     * 不纠正的话竖拍照片在服务端和 PC 上会显示为横躺，且不同手机表现不一致。
     */
    fun decodeWithOrientation(path: String, maxDimension: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        val w = bounds.outWidth
        val h = bounds.outHeight
        if (w <= 0 || h <= 0) return null

        // 先按 2 的幂降采样，避免直接把 4000×3000 的原图读入内存
        var sample = 1
        while (maxOf(w, h) / sample > maxDimension) sample *= 2

        val opts = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val bitmap = BitmapFactory.decodeFile(path, opts) ?: return null
        return rotateByExif(bitmap, path)
    }

    private fun rotateByExif(bitmap: Bitmap, path: String): Bitmap {
        val orientation = runCatching {
            ExifInterface(path).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL
            )
        }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)

        val degrees = when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
        if (degrees == 0f) return bitmap
        val matrix = Matrix().apply { postRotate(degrees) }
        val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        if (rotated !== bitmap) bitmap.recycle()
        return rotated
    }

    /** 精确缩放到长边不超过 max（降采样只到 2 的幂，这里补足精度） */
    fun scaleToMax(src: Bitmap, max: Int): Bitmap {
        val longEdge = maxOf(src.width, src.height)
        if (longEdge <= max) return src
        val ratio = max.toFloat() / longEdge.toFloat()
        val w = (src.width * ratio).toInt().coerceAtLeast(1)
        val h = (src.height * ratio).toInt().coerceAtLeast(1)
        val scaled = Bitmap.createScaledBitmap(src, w, h, true)
        if (scaled !== src) src.recycle()
        return scaled
    }

    /**
     * 叠加时间水印（右上角）。
     *
     * 位置与桌面端一致：右上角。半透明黑底 + 白字是为了在任何衣物颜色上都可读——
     * 纯白字在浅色羽绒服上几乎看不见，纯黑字在深色西装上同样。
     */
    fun drawWatermark(src: Bitmap, text: String): Bitmap {
        if (text.isBlank()) return src
        val out = src.copy(src.config ?: Bitmap.Config.ARGB_8888, true)
        val canvas = Canvas(out)

        // 字号随图片宽度自适应：小图用固定 px 会糊成一团，大图又会小到看不见
        val textSize = (out.width * 0.032f).coerceIn(18f, 46f)
        val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            this.textSize = textSize
            typeface = Typeface.DEFAULT_BOLD
            setShadowLayer(2f, 1f, 1f, Color.parseColor("#80000000"))
        }

        val padX = textSize * 0.5f
        val padY = textSize * 0.35f
        val textWidth = textPaint.measureText(text)
        val fm = textPaint.fontMetrics
        val textHeight = fm.descent - fm.ascent

        val boxRight = out.width - (out.width * 0.03f)
        val boxTop = out.height * 0.03f
        val boxLeft = boxRight - textWidth - padX * 2
        val boxBottom = boxTop + textHeight + padY * 2

        val boxPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#66000000")
            style = Paint.Style.FILL
        }
        canvas.drawRoundRect(boxLeft, boxTop, boxRight, boxBottom, textSize * 0.3f, textSize * 0.3f, boxPaint)

        val baseline = boxTop + padY - fm.ascent
        canvas.drawText(text, boxLeft + padX, baseline, textPaint)
        return out
    }

    fun writeJpeg(bitmap: Bitmap, out: File, quality: Int): Boolean {
        out.parentFile?.mkdirs()
        return runCatching {
            FileOutputStream(out).use { fos ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(30, 100), fos)
                fos.flush()
            }
            true
        }.getOrDefault(false)
    }

    /** 估算上传体积，用于弱网提示（返回字节数） */
    fun estimateSize(file: File): Long = runCatching { file.length() }.getOrDefault(0L)

    /** 图片实际宽高，写入日志/详情用 */
    fun sizeOf(path: String): Pair<Int, Int> {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, o)
        return o.outWidth to o.outHeight
    }
}
