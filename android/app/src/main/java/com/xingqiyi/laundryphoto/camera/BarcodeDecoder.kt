package com.xingqiyi.laundryphoto.camera

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlin.math.max

/**
 * 条码 / 二维码解码：**纯 Java，不依赖任何 Android API**，可直接单元测试。
 *
 * ## 为什么选 ZXing 而不是 ML Kit
 *
 * ML Kit 的 barcode-scanning 走的是 Google Play Services 动态下发模型，
 * 而本系统的门店设备（国产平板、收银一体机）**普遍没有 GMS**：
 * 装上去的表现不是报错，而是「扫任何码都没有反应」，故障完全不可见。
 * ZXing 是纯 Java 实现，随 APK 打包即可离线工作，与 minSdk 26 的兼容面完全一致，
 * 代价只是 APK 增加约 600KB。对「拍一张衣物吊牌」这个诉求，
 * 离线可用远比识别率高几个百分点重要。
 *
 * ## 为什么只取 YUV 的 Y 平面
 *
 * 条码识别只需要亮度（luminance），而 YUV_420_888 的 Y 平面恰好就是全分辨率灰度图。
 * 走 Y 平面可以省掉整帧 YUV→RGB 的转换（1920×1080 每帧约 6MB 写入），
 * 这是千元机上能否流畅预览的关键。
 *
 * ## 关于旋转方向（改动前务必读完，否则会「改对了反而扫不出」）
 *
 * 这里按 ImageProxy.imageInfo.rotationDegrees 做**顺时针**旋转到正向。
 * 好消息是这个约定即使搞反也**不影响识别结果**：
 * 90° 与 270° 之间恰好相差 180°，而 180° 旋转对解码是等价的——
 *   - 一维码：ZXing 逐行横向扫描，上下翻转不改变任何一行的横向内容，
 *     左右镜像则已被 OneDReader 的 reversed 分支覆盖；
 *   - 二维码：靠三个定位图案定方向，本身旋转无关。
 * 真正**必须**处理的是 0/180 与 90/270 的区分：
 * 若该转 90 度时没转，条码在缓冲区里是竖直的，一维码就彻底扫不出来了。
 */
object BarcodeDecoder {

    /** 支持的码制：覆盖衣物吊牌、快递面单与自建二维码的全部常见形态 */
    private val FORMATS: List<BarcodeFormat> = listOf(
        BarcodeFormat.QR_CODE,
        BarcodeFormat.DATA_MATRIX,
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.CODE_93,
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.ITF,
        BarcodeFormat.CODABAR
    )

    /**
     * 刻意**不开** TRY_HARDER：它会对同一帧做多尺度、多角度重试，
     * 单帧耗时翻数倍，在千元机上直接掉到 2~3 fps，用户反而更难对准。
     * 现场条码基本都是正对着的，速度比极限识别率重要。
     */
    private val HINTS: Map<DecodeHintType, Any> = mapOf(
        DecodeHintType.POSSIBLE_FORMATS to FORMATS
    )

    /**
     * MultiFormatReader 不是线程安全的，而 CameraX 的分析回调可能落在不同线程，
     * 因此每个线程持有一个实例（避免每帧 new 一个、也避免跨线程共用）。
     */
    private val readers = ThreadLocal.withInitial {
        MultiFormatReader().apply { setHints(HINTS) }
    }

    /** 一幅灰度图：宽高 + 行优先的亮度字节 */
    data class Luma(val data: ByteArray, val width: Int, val height: Int)

    /**
     * 解码一幅灰度图。
     * @return 码值（已去空白）；无码或解码异常返回 null。**不抛异常**——
     *         分析回调里任何抛出都会终止整个 ImageAnalysis，绝不能让它冒泡。
     */
    fun decode(luma: Luma): String? {
        if (luma.width <= 0 || luma.height <= 0) return null
        if (luma.data.size < luma.width * luma.height) return null
        return runCatching {
            val source = PlanarYUVLuminanceSource(
                luma.data, luma.width, luma.height,
                0, 0, luma.width, luma.height,
                false // 不做水平镜像
            )
            val bitmap = BinaryBitmap(HybridBinarizer(source))
            val reader = readers.get() ?: return@runCatching null
            reader.decode(bitmap, HINTS)?.text?.trim()?.takeIf { it.isNotEmpty() }
        }.getOrNull()
    }

    /**
     * 顺时针旋转到正向。degrees 为 0 时直接返回原对象（不做无谓的 2MB 拷贝）。
     *
     * @param degrees ImageProxy 的 rotationDegrees，实际只会是 0/90/180/270
     */
    fun rotate(luma: Luma, degrees: Int): Luma {
        val d = ((degrees % 360) + 360) % 360
        if (d == 0) return luma

        val w = luma.width
        val h = luma.height
        val src = luma.data
        val out = ByteArray(w * h)

        when (d) {
            90 -> {
                // 目标：宽高互换；(sx, sy) → (h - 1 - sy, sx)
                for (sy in 0 until h) {
                    val srcRow = sy * w
                    var i = srcRow
                    val nx = h - 1 - sy
                    for (sx in 0 until w) {
                        out[sx * h + nx] = src[i++]
                    }
                }
                return Luma(out, h, w)
            }
            180 -> {
                // (sx, sy) → (w - 1 - sx, h - 1 - sy)，宽高不变
                for (sy in 0 until h) {
                    val srcRow = sy * w
                    val dstRow = (h - 1 - sy) * w
                    for (sx in 0 until w) {
                        out[dstRow + (w - 1 - sx)] = src[srcRow + sx]
                    }
                }
                return Luma(out, w, h)
            }
            270 -> {
                // (sx, sy) → (sy, w - 1 - sx)
                for (sy in 0 until h) {
                    val srcRow = sy * w
                    for (sx in 0 until w) {
                        out[(w - 1 - sx) * h + sy] = src[srcRow + sx]
                    }
                }
                return Luma(out, h, w)
            }
            else -> return luma
        }
    }

    /**
     * 居中裁剪一块区域再解码。
     *
     * 裁剪有两个实际收益：
     * 1. 省算力——只二值化真正可能有码的中间区域；
     * 2. 让「把条码放进框里」这句提示名副其实：框外的干扰码（货架标签、隔壁衣物）
     *    不会被误扫成当前衣物的条码，这在密集挂衣区是刚需。
     *
     * 注意这里刻意用**对称**比例（宽高同比例）而不是照搬 UI 取景框的比例：
     * 预览控件的 FILL_CENTER 会把画面裁掉一部分，UI 框的位置与缓冲区坐标并非 1:1，
     * 用对称比例可以保证「框里能看见的」一定落在裁剪区内，不会出现看得见却扫不出。
     */
    fun crop(luma: Luma, fraction: Float): Luma {
        val f = fraction.coerceIn(0.1f, 1f)
        if (f >= 1f) return luma
        val cw = max(1, (luma.width * f).toInt())
        val ch = max(1, (luma.height * f).toInt())
        val left = (luma.width - cw) / 2
        val top = (luma.height - ch) / 2

        val out = ByteArray(cw * ch)
        var o = 0
        for (y in top until (top + ch)) {
            val rowStart = y * luma.width
            for (x in left until (left + cw)) {
                out[o++] = luma.data[rowStart + x]
            }
        }
        return Luma(out, cw, ch)
    }

    /** 裁剪比例：兼顾「框内才扫」与「略微抖动也扫得到」 */
    const val DEFAULT_CROP_FRACTION = 0.78f
}
