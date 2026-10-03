package com.xingqiyi.laundryphoto.util

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * 连拍存储的路径安全化。
 *
 * 这组用例守的是一条**安全边界**：条码来自扫码识别，是彻头彻尾的外部输入。
 * 一个被恶意构造的二维码（内容是 `../../.ssh/authorized_keys` 之类）
 * 如果原样拿去拼目录名，就能把照片写到应用私有目录之外。
 * 这类问题在正常使用中永远不会暴露，一旦暴露就是事故，因此必须有断言盯着。
 */
class BurstPhotoStoreTest {

    @Test
    fun `正常条码原样保留`() {
        assertThat(BurstPhotoStore.safeName("XQY-2026-000137")).isEqualTo("XQY-2026-000137")
        assertThat(BurstPhotoStore.safeName("ABC_123")).isEqualTo("ABC_123")
        assertThat(BurstPhotoStore.safeName("羽绒服001")).isEqualTo("羽绒服001")
    }

    @Test
    fun `路径穿越字符被替换`() {
        val name = BurstPhotoStore.safeName("../../etc/passwd")
        assertThat(name).doesNotContain("/")
        assertThat(name).doesNotContain("..")
        assertThat(name).isEqualTo("etc_passwd")
    }

    @Test
    fun `斜杠与反斜杠都不会留下`() {
        assertThat(BurstPhotoStore.safeName("a/b")).doesNotContain("/")
        assertThat(BurstPhotoStore.safeName("a\\b")).doesNotContain("\\")
    }

    @Test
    fun `空条码与全非法字符有兜底名`() {
        assertThat(BurstPhotoStore.safeName("")).isEqualTo("未命名")
        assertThat(BurstPhotoStore.safeName("///")).isEqualTo("未命名")
        assertThat(BurstPhotoStore.safeName("***")).isEqualTo("未命名")
    }

    /** 超长条码要截断：文件系统对单级目录名有 255 字节上限，中文占 3 字节 */
    @Test
    fun `超长条码被截断到安全长度`() {
        val long = "A".repeat(500)
        assertThat(BurstPhotoStore.safeName(long).length).isAtMost(64)
    }

    /** 首尾的下划线要去掉，避免生成 "." 这类特殊目录名 */
    @Test
    fun `首尾下划线被裁掉`() {
        assertThat(BurstPhotoStore.safeName("_abc_")).isEqualTo("abc")
    }
}
