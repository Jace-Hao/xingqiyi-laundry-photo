package com.xingqiyi.laundryphoto.util

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * BarcodeUtil 是纯函数模块（无 Android 依赖），其判定口径必须与桌面端 renderer.js 逐条一致，
 * 因此这里把关键分支都覆盖到：误读预警、相似条码、格式画像、近形修复。
 */
class BarcodeUtilTest {

    @Test
    fun hasSuspicious_detectsIllegalChars() {
        assertThat(BarcodeUtil.hasSuspicious("ABC123")).isFalse()
        assertThat(BarcodeUtil.hasSuspicious("A_B-1")).isFalse()
        assertThat(BarcodeUtil.hasSuspicious("A B")).isTrue()      // 空格
        assertThat(BarcodeUtil.hasSuspicious("A/B")).isTrue()      // 斜杠
        assertThat(BarcodeUtil.hasSuspicious("A.B")).isTrue()      // 点
        assertThat(BarcodeUtil.hasSuspicious(null)).isFalse()
    }

    @Test
    fun editDistance_basicCases() {
        assertThat(BarcodeUtil.editDistance("", "")).isEqualTo(0)
        assertThat(BarcodeUtil.editDistance("abc", "abc")).isEqualTo(0)
        assertThat(BarcodeUtil.editDistance("abc", "abd")).isEqualTo(1)
        assertThat(BarcodeUtil.editDistance("kitten", "sitting")).isEqualTo(3)
    }

    @Test
    fun editDistance_capPruning() {
        // 长度差已超过 cap(2)，即使继续算也应提前返回 cap+1
        assertThat(BarcodeUtil.editDistance("123", "1234567", cap = 2)).isEqualTo(3)
    }

    @Test
    fun similarList_findsNearMissesAndExcludesShort() {
        val known = listOf("123456", "123457", "123458", "ABCDEF", "12")
        val result = BarcodeUtil.similarList("123456", known)
        assertThat(result).contains("123457")
        assertThat(result).contains("123458")
        assertThat(result).doesNotContain("12")        // 短码不参与
        assertThat(result).doesNotContain("ABCDEF")    // 编辑距离过大
    }

    @Test
    fun similarList_prefixMatch() {
        val known = listOf("1234567890")
        // 目标短于库中条码（扫码多读/截断尾字符）-> 命中前缀相似
        assertThat(BarcodeUtil.similarList("123456", known)).contains("1234567890")
        // 目标长于库中条码（扫码漏读）-> 同样命中
        assertThat(BarcodeUtil.similarList("1234567890123", known)).contains("1234567890")
        // 完全相同的条码不算「相似」：它已经建过档，再提示一次只会让店员误以为系统误报
        assertThat(BarcodeUtil.similarList("1234567890", known)).isEmpty()
    }

    @Test
    fun similarList_shortTargetReturnsEmpty() {
        assertThat(BarcodeUtil.similarList("123", listOf("123456"))).isEmpty()
    }

    @Test
    fun formatProfile_requiresEnoughSamples() {
        // 样本不足 10 条 -> null
        val few = List(5) { "B${it.toString().padStart(5, '0')}" }
        assertThat(BarcodeUtil.formatProfile(few)).isNull()

        // 12 条同长度样本（"A" + 6 位数字 = 7 字符）-> 主长度为 7，字符集含数字
        val many = List(12) { "A${(100000 + it).toString()}" }
        val profile = BarcodeUtil.formatProfile(many)
        assertThat(profile).isNotNull()
        assertThat(profile!!.mainLen).isEqualTo(7)
        // charset 是 String，Truth 的 contains 走 CharSequence 重载，必须传字符串而非字符
        assertThat(profile.charset).contains("0")
    }

    @Test
    fun repair_appliesNearMissOnlyWhenTargetInCharset() {
        val profile = BarcodeUtil.FormatProfile(mainLen = 6, charset = "0123456789", sample = 12)
        // O 不在字符集，但 0 在 -> 修复成 0
        val r = BarcodeUtil.repair("O12345", profile)
        assertThat(r.value).isEqualTo("012345")
        assertThat(r.fixes).contains("O→0")

        // 字符本就在字符集 -> 不改动
        val r2 = BarcodeUtil.repair("012345", profile)
        assertThat(r2.value).isEqualTo("012345")
        assertThat(r2.fixes).isEmpty()
    }

    @Test
    fun deviatesFromProfile_lengthAndCharset() {
        val profile = BarcodeUtil.FormatProfile(mainLen = 6, charset = "0123456789", sample = 12)
        assertThat(BarcodeUtil.deviatesFromProfile("012345", profile)).isFalse()
        assertThat(BarcodeUtil.deviatesFromProfile("01234", profile)).isTrue()   // 长度不符
        assertThat(BarcodeUtil.deviatesFromProfile("01A345", profile)).isTrue() // 含非法字符
        assertThat(BarcodeUtil.deviatesFromProfile("012345", null)).isFalse()   // 无画像不判违例
    }
}
