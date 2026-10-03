package com.xingqiyi.laundryphoto.camera

import android.graphics.ImageFormat
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import java.nio.ByteBuffer

/**
 * 从相机帧里实时识别条码。
 *
 * 三条硬性约束（每一条都是踩过的坑）：
 * 1. **必须 close()**。ImageProxy 来自 CameraX 的帧缓冲池，不 close 会让后续帧全部阻塞，
 *    表现为「预览卡住不动」。因此所有提前 return 的路径都走 finally 统一 close。
 * 2. **绝不能抛异常**。analyze() 里任何抛出都会终止整个 ImageAnalysis 用例，
 *    之后再也收不到帧，而界面上看不出任何错误——只剩「扫不出来」。
 *    所以解码整个包在 runCatching 里，识别不到是常态而非异常。
 * 3. **节流**。低端机上逐帧二值化 1080p 会吃掉一个核，这里限制到约 5 次/秒。
 *    人手持手机对准条码的动作远慢于此，省下的算力留给预览流畅度。
 */
class BarcodeAnalyzer(
    private val cropFraction: Float = BarcodeDecoder.DEFAULT_CROP_FRACTION,
    private val minIntervalMs: Long = MIN_INTERVAL_MS,
    private val onResult: (String) -> Unit
) : ImageAnalysis.Analyzer {

    /** 命中一次后就停止分析：连拍页已经在等结果了，继续扫只会误扫到第二件衣物的条码 */
    @Volatile
    private var handled = false

    @Volatile
    private var lastAnalyzeAtMs = 0L

    override fun analyze(image: ImageProxy) {
        if (handled) {
            image.close()
            return
        }
        val now = System.currentTimeMillis()
        if (now - lastAnalyzeAtMs < minIntervalMs) {
            image.close()
            return
        }
        lastAnalyzeAtMs = now

        try {
            val luma = extractYPlane(image) ?: return
            val upright = BarcodeDecoder.rotate(luma, image.imageInfo.rotationDegrees)
            val text = BarcodeDecoder.decode(BarcodeDecoder.crop(upright, cropFraction))
            if (!text.isNullOrBlank() && !handled) {
                handled = true
                onResult(text)
            }
        } catch (t: Throwable) {
            // 单帧失败（尺寸异常、缓冲区越界）不影响后续帧，静默跳过即可
        } finally {
            image.close()
        }
    }

    /**
     * 重新开启识别（用户点了「重新识别」）。
     * 不加这个复位，识别过一次之后页面就永远是「已命中」状态，重试按钮形同虚设。
     */
    fun reset() {
        handled = false
        lastAnalyzeAtMs = 0L
    }

    /**
     * 取出 YUV_420_888 的 Y 平面并**压实**成连续数组。
     *
     * 不能直接把 plane.buffer 当数组用：rowStride 通常大于 width（有对齐填充），
     * 直接读会得到错位且右侧带垃圾像素的图像，表现为「某些机型扫不出、某些能扫出」。
     */
    private fun extractYPlane(image: ImageProxy): BarcodeDecoder.Luma? {
        if (image.format != ImageFormat.YUV_420_888) return null
        if (image.planes.isEmpty()) return null

        val w = image.width
        val h = image.height
        if (w <= 0 || h <= 0) return null

        val plane = image.planes[0]
        val buffer: ByteBuffer = plane.buffer
        val rowStride = plane.rowStride
        val pixelStride = plane.pixelStride
        val out = ByteArray(w * h)

        if (pixelStride == 1 && rowStride == w) {
            // 连续布局：整帧一次拷出，避免逐像素循环（1080p 下差好几毫秒）
            buffer.position(0)
            buffer.get(out, 0, w * h)
        } else {
            var o = 0
            for (y in 0 until h) {
                val rowStart = y * rowStride
                var i = rowStart
                for (x in 0 until w) {
                    out[o++] = buffer[i]
                    i += pixelStride
                }
            }
        }
        return BarcodeDecoder.Luma(out, w, h)
    }

    private companion object {
        /** 200ms ≈ 每秒 5 次，见类注释第 3 条 */
        const val MIN_INTERVAL_MS = 200L
    }
}
