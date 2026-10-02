package com.xingqiyi.laundryphoto.util

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/**
 * 时间格式化与筛选区间换算。
 *
 * 服务端所有时间字段都是 ISO-8601（UTC，形如 2026-10-01T10:30:00.000Z），
 * 界面展示必须转成本地时区——直接用字符串截取会把 UTC 当成北京时间，
 * 晚上拍的照片会显示成第二天早上，对账时是致命的。
 */
object DateTimeUtil {

    private val FULL = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
    private val SHORT = DateTimeFormatter.ofPattern("MM-dd HH:mm")
    private val DATE = DateTimeFormatter.ofPattern("yyyy-MM-dd")
    private val WATERMARK = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

    /** 当前时间的水印文案（与桌面端一致：精确到分钟） */
    fun watermarkNow(): String = WATERMARK.format(Instant.now().atZone(ZoneId.systemDefault()))

    /** ISO 字符串 → 毫秒；解析失败返回 0（调用方按「未知时间」处理，不要让它崩） */
    fun toMillis(iso: String?): Long {
        if (iso.isNullOrBlank()) return 0L
        return try {
            Instant.parse(iso).toEpochMilli()
        } catch (e: DateTimeParseException) {
            0L
        }
    }

    /** 完整时间：2026-10-01 18:30 */
    fun formatFull(iso: String?): String {
        val ms = toMillis(iso)
        if (ms == 0L) return "-"
        return FULL.format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))
    }

    /** 紧凑时间（列表用）：10-01 18:30 */
    fun formatShort(iso: String?): String {
        val ms = toMillis(iso)
        if (ms == 0L) return "-"
        val zoned = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault())
        // 同年只显示月日，跨年补上年份，避免历史数据看起来像今年的
        return if (zoned.year == LocalDate.now().year) SHORT.format(zoned) else FULL.format(zoned)
    }

    /** 日期部分：2026-10-01 */
    fun formatDate(iso: String?): String {
        val ms = toMillis(iso)
        if (ms == 0L) return "-"
        return DATE.format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))
    }

    /** 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 昨天 18:30 / 10-01 18:30 */
    fun formatRelative(iso: String?): String {
        val ms = toMillis(iso)
        if (ms == 0L) return "-"
        val diff = System.currentTimeMillis() - ms
        return when {
            diff < 60_000 -> "刚刚"
            diff < 3_600_000 -> "${diff / 60_000} 分钟前"
            diff < 24 * 3_600_000 -> "${diff / 3_600_000} 小时前"
            diff < 48 * 3_600_000 -> "昨天 ${FULL.format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault())).substring(11)}"
            else -> formatShort(iso)
        }
    }

    /** 当前时间的 ISO 串（与服务端 createdAt 同一格式，离线入队排序用） */
    fun nowIso(): String = Instant.now().toString()

    /** 今天 00:00 的日期串，作为筛选默认值 */
    fun today(): String = LocalDate.now().format(DATE)

    /** 往前推 days 天 */
    fun daysAgo(days: Int): String = LocalDate.now().minusDays(days.toLong()).format(DATE)
}
