package com.xingqiyi.laundryphoto.util

/**
 * 条码纠错：与桌面端 renderer.js 的同名逻辑保持一致的判定口径。
 *
 * 现场问题是扫码枪把 O 读成 0、I 读成 1 这类近形误读，导致同一件衣物被建成两个条码档案，
 * 后期对账极其麻烦。因此拍照前做「相似条码」预警，命中时要求人工确认。
 *
 * 判定口径刻意与桌面端逐条对齐（长度下限 6、编辑距离上限 2、长度差上限 2、最多 5 条、
 * 格式画像需 10 条样本）：两端给出不一致的提示会让店员无所适从，
 * 而阈值本身是现场调出来的，不是理论最优值。
 *
 * 全部为纯函数，不依赖 Android，可直接单元测试。
 */
object BarcodeUtil {

    /** 参与相似比对的最小长度：短码（如「001」）彼此差异天然很小，容易误报 */
    private const val MIN_COMPARE_LEN = 6
    private const val MAX_EDIT_DISTANCE = 2
    private const val MAX_LEN_DIFF = 2
    private const val MAX_SUGGESTIONS = 5

    /** 格式画像的最小样本量：少于 10 条时长度/字符集规律不可靠，宁可不判定 */
    private const val MIN_PROFILE_SAMPLES = 10

    /**
     * 是否含可疑字符。
     * 合法字符集：字母、数字、下划线、连字符、中文。其余（空格、斜杠、点等）一律可疑。
     */
    fun hasSuspicious(raw: String?): Boolean {
        val s = raw ?: return false
        for (ch in s) {
            val ok = ch in '0'..'9' || ch in 'A'..'Z' || ch in 'a'..'z' ||
                ch == '_' || ch == '-' || ch in '\u4e00'..'\u9fa5'
            if (!ok) return true
        }
        return false
    }

    /**
     * 受上限约束的编辑距离。
     * 超过 [cap] 立即返回 cap+1：条码比对只关心「是否足够接近」，
     * 提前剪枝可以省掉大部分计算（库里条码可能上千条）。
     */
    fun editDistance(a: String, b: String, cap: Int = MAX_EDIT_DISTANCE): Int {
        val m = a.length
        val n = b.length
        if (kotlin.math.abs(m - n) > cap) return cap + 1
        var prev = IntArray(n + 1) { it }
        for (i in 1..m) {
            val cur = IntArray(n + 1)
            cur[0] = i
            var best = i
            for (j in 1..n) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                val v = minOf(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
                cur[j] = v
                if (v < best) best = v
            }
            // 整行最小值都已超过上限，后续行只会更大
            if (best > cap) return cap + 1
            prev = cur
        }
        return prev[n]
    }

    /**
     * 与当前条码相似的已有条码。
     * 两类命中：前缀包含（扫码截断或多读尾字符）、编辑距离 ≤2（漏读或误读字符）。
     */
    fun similarList(target: String, known: List<String>): List<String> {
        val s = target.trim()
        if (s.length < MIN_COMPARE_LEN) return emptyList()
        val out = LinkedHashSet<String>()
        for (raw in known) {
            val k = raw.trim()
            if (k.isEmpty() || k == s || k.length < MIN_COMPARE_LEN) continue
            if (s.startsWith(k) || k.startsWith(s)) {
                out.add(k)
                continue
            }
            if (kotlin.math.abs(s.length - k.length) <= MAX_LEN_DIFF &&
                editDistance(s, k, MAX_EDIT_DISTANCE) <= MAX_EDIT_DISTANCE
            ) {
                out.add(k)
            }
        }
        return out.take(MAX_SUGGESTIONS)
    }

    /**
     * 从库中条码总结「格式画像」：出现最多的长度为主长度，字符集取并集。
     * 样本不足或主长度不占多数时返回 null（无规律可参照就别瞎提示）。
     */
    fun formatProfile(known: List<String>): FormatProfile? {
        val list = known.map { it.trim() }.filter { it.length >= MIN_COMPARE_LEN }
        if (list.size < MIN_PROFILE_SAMPLES) return null

        val lenCount = mutableMapOf<Int, Int>()
        for (s in list) lenCount[s.length] = (lenCount[s.length] ?: 0) + 1

        var mainLen = 0
        var mainCount = 0
        for ((len, c) in lenCount) {
            if (c > mainCount || (c == mainCount && len > mainLen)) {
                mainLen = len
                mainCount = c
            }
        }
        if (mainCount < maxOf(2, kotlin.math.ceil(list.size / 2.0).toInt())) return null

        val charset = LinkedHashSet<Char>()
        for (s in list) for (ch in s) charset.add(ch)
        return FormatProfile(mainLen = mainLen, charset = charset.joinToString(""), sample = list.size)
    }

    /** 扫码枪近形误读映射：字母/符号 → 数字 */
    private val NEAR_MISS = mapOf(
        'O' to '0', 'Q' to '0', 'D' to '0', 'o' to '0',
        'I' to '1', 'L' to '1', 'l' to '1', 'i' to '1',
        'Z' to '2', 'z' to '2',
        'A' to '4',
        'S' to '5', 's' to '5',
        'B' to '6', 'b' to '6', 'G' to '6',
        'T' to '7',
        'E' to '8',
        'g' to '9', 'q' to '9'
    )

    /**
     * 修复式纠错：把不在库内字符集里的字符按近形映射修正。
     * 仅在库内字符集确实含目标数字时才替换，避免把本就正确的字母改坏。
     */
    fun repair(raw: String, profile: FormatProfile?): RepairResult {
        val src = raw
        if (profile == null) return RepairResult(src, emptyList())
        val chars = StringBuilder()
        val fixes = mutableListOf<String>()
        for (ch in src) {
            if (profile.charset.contains(ch)) {
                chars.append(ch)
                continue
            }
            val mapped = NEAR_MISS[ch]
            if (mapped != null && profile.charset.contains(mapped)) {
                chars.append(mapped)
                fixes.add("$ch→$mapped")
            } else {
                chars.append(ch)
            }
        }
        return RepairResult(chars.toString(), fixes)
    }

    /** 是否偏离格式画像（长度不符或含非法字符） */
    fun deviatesFromProfile(value: String, profile: FormatProfile?): Boolean {
        if (profile == null) return false
        if (value.length != profile.mainLen) return true
        return value.any { it !in profile.charset }
    }

    data class FormatProfile(
        val mainLen: Int,
        val charset: String,
        val sample: Int
    )

    data class RepairResult(
        val value: String,
        val fixes: List<String>
    )
}
