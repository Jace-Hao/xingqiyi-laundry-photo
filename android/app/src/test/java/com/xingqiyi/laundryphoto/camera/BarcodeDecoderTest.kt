package com.xingqiyi.laundryphoto.camera

import com.google.common.truth.Truth.assertThat
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import com.google.zxing.common.BitMatrix
import org.junit.Test

/**
 * 扫码解码链路测试。
 *
 * ## 为什么必须测这一层
 *
 * [BarcodeDecoder] 是纯 Java，可以在 JVM 上直接跑，
 * 而**真机上「扫不出来」的绝大多数原因都藏在这段像素处理里**：
 * Y 平面没压实（读成错位图像）、旋转方向搞反（一维码变成竖的，永远扫不出）、
 * 裁剪区域偏了（框里看得见却不在分析范围内）。
 * 这些故障在真机上的表现完全一致——「没反应，也没报错」——靠肉眼看代码很难发现。
 *
 * 因此这里用 ZXing 自己的 Writer 先**画**出条码，再走一遍完整的
 * 旋转 → 裁剪 → 解码，形成闭环。任何一环改坏都会立刻在这里红。
 */
class BarcodeDecoderTest {

    private val payload = "XQY-2026-000137"

    /** 把 BitMatrix 渲染成带静区的灰度图（黑 0 / 白 255） */
    private fun render(matrix: BitMatrix, margin: Int = 40): BarcodeDecoder.Luma {
        val w = matrix.width + margin * 2
        val h = matrix.height + margin * 2
        val data = ByteArray(w * h)
        // 白底：静区必须是白的，否则 ZXing 找不到码的边界
        data.fill(0xFF.toByte())
        for (y in 0 until matrix.height) {
            for (x in 0 until matrix.width) {
                if (matrix[x, y]) data[(y + margin) * w + (x + margin)] = 0
            }
        }
        return BarcodeDecoder.Luma(data, w, h)
    }

    private fun oneDimensional(): BarcodeDecoder.Luma =
        render(MultiFormatWriter().encode(payload, BarcodeFormat.CODE_128, 400, 120))

    private fun qrCode(): BarcodeDecoder.Luma =
        render(MultiFormatWriter().encode(payload, BarcodeFormat.QR_CODE, 240, 240))

    @Test
    fun `正向一维码可以解出码值`() {
        assertThat(BarcodeDecoder.decode(oneDimensional())).isEqualTo(payload)
    }

    @Test
    fun `二维码可以解出码值`() {
        assertThat(BarcodeDecoder.decode(qrCode())).isEqualTo(payload)
    }

    /**
     * 180° 旋转后仍然要能解出来。
     *
     * 这不是「顺手加的用例」：相机上报的 rotationDegrees 是 90 还是 270，
     * 不同厂商的实现口径并不统一，两者恰好相差 180°。
     * 只要 180° 等价成立，90/270 的口径差异就不会导致扫不出来——
     * 这条断言正是为这个结论背书。
     */
    @Test
    fun `一维码旋转 180 度后仍可解码`() {
        val rotated = BarcodeDecoder.rotate(oneDimensional(), 180)
        assertThat(BarcodeDecoder.decode(rotated)).isEqualTo(payload)
    }

    /** 二维码本身旋转无关：任意角度都应能解出 */
    @Test
    fun `二维码旋转 90 度后仍可解码`() {
        assertThat(BarcodeDecoder.decode(BarcodeDecoder.rotate(qrCode(), 90))).isEqualTo(payload)
    }

    /** 一维码旋转 90 度后变成竖的，必然解不出——这正是「必须按 rotationDegrees 转正」的原因 */
    @Test
    fun `一维码旋转 90 度后解不出`() {
        assertThat(BarcodeDecoder.decode(BarcodeDecoder.rotate(oneDimensional(), 90))).isNull()
    }

    /** 旋转的纯数学自检：90 与 270 互逆，180 与自身互逆 */
    @Test
    fun `旋转是可逆的`() {
        val src = oneDimensional()
        val back = BarcodeDecoder.rotate(BarcodeDecoder.rotate(src, 90), 270)
        assertThat(back.width).isEqualTo(src.width)
        assertThat(back.height).isEqualTo(src.height)
        assertThat(back.data).isEqualTo(src.data)

        val twice = BarcodeDecoder.rotate(BarcodeDecoder.rotate(src, 180), 180)
        assertThat(twice.data).isEqualTo(src.data)
    }

    /** degrees 为 0 时必须原样返回：1080p 下省掉一次 2MB 拷贝 */
    @Test
    fun `旋转 0 度时复用原对象`() {
        val src = oneDimensional()
        assertThat(BarcodeDecoder.rotate(src, 0)).isSameInstanceAs(src)
        assertThat(BarcodeDecoder.rotate(src, 360)).isSameInstanceAs(src)
    }

    /** 裁剪只保留居中区域：居中的条码裁剪后仍在范围内 */
    @Test
    fun `居中裁剪后仍能解出居中的码`() {
        val cropped = BarcodeDecoder.crop(oneDimensional(), BarcodeDecoder.DEFAULT_CROP_FRACTION)
        assertThat(cropped.width).isLessThan(oneDimensional().width)
        assertThat(BarcodeDecoder.decode(cropped)).isEqualTo(payload)
    }

    /** 裁剪比例越界时收敛到合法区间，不能算出负宽高 */
    @Test
    fun `裁剪比例被限制在合法范围`() {
        val src = oneDimensional()
        val tiny = BarcodeDecoder.crop(src, 0f)
        assertThat(tiny.width).isAtLeast(1)
        assertThat(tiny.height).isAtLeast(1)
        assertThat(BarcodeDecoder.crop(src, 5f)).isSameInstanceAs(src)
    }

    /** 空白画面返回 null 而不是抛异常：解码不到是常态，绝不能让异常冒泡到分析回调 */
    @Test
    fun `没有条码时返回 null`() {
        val blank = BarcodeDecoder.Luma(ByteArray(64 * 64).apply { fill(0xFF.toByte()) }, 64, 64)
        assertThat(BarcodeDecoder.decode(blank)).isNull()
    }

    /** 缓冲区与宽高不匹配时安全返回 null（防止越界崩溃） */
    @Test
    fun `缓冲区长度不足时返回 null`() {
        assertThat(BarcodeDecoder.decode(BarcodeDecoder.Luma(ByteArray(10), 100, 100))).isNull()
        assertThat(BarcodeDecoder.decode(BarcodeDecoder.Luma(ByteArray(0), 0, 0))).isNull()
    }

    /** 非法角度不应崩溃，也不应改变图像；负角度按模 360 归一 */
    @Test
    fun `非法旋转角度原样返回`() {
        val src = oneDimensional()
        assertThat(BarcodeDecoder.rotate(src, 45)).isSameInstanceAs(src)
        // ByteArray 的 equals 是引用比较，必须逐字节比内容
        assertThat(BarcodeDecoder.rotate(src, -90).data)
            .isEqualTo(BarcodeDecoder.rotate(src, 270).data)
    }
}
