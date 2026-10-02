package com.xingqiyi.laundryphoto.util

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 照片下载与分享。
 *
 * 为什么不直接写公共相册：
 * - Android 10 起分区存储，写公共目录要走 MediaStore，且 Android 13 又换成细粒度媒体权限，
 *   三条版本的写法完全不同；
 * - 本系统的照片是「衣物存档凭证」，把它散落到店员个人相册里既无必要也有隐私风险。
 *
 * 因此统一采用「下载到应用私有目录 → 通过 FileProvider 分享」：
 * 一个实现覆盖全部系统版本，不需要任何存储权限，
 * 用户可以选择存进相册、发微信给客户，或存到网盘，交由系统分享面板决定。
 */
object PhotoSaver {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    /**
     * 下载照片到应用私有缓存。
     * @return 成功返回文件，失败返回 null
     */
    suspend fun fetch(context: Context, url: String, fileName: String): File? {
        if (url.isBlank()) return null
        return runCatching {
            val dir = File(context.cacheDir, "share").apply { mkdirs() }
            val out = File(dir, fileName)
            client.newCall(Request.Builder().url(url).build()).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body ?: return null
                out.outputStream().use { os -> body.byteStream().copyTo(os) }
            }
            out
        }.getOrNull()
    }

    /** 调起系统分享面板 */
    fun share(context: Context, file: File, title: String = "分享照片") {
        runCatching {
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file
            )
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "image/jpeg"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(Intent.createChooser(intent, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    /** 文件名：条码_第N张_时间.jpg，去掉 Windows/Unix 都不接受的字符 */
    fun fileNameOf(barcode: String, seq: Int, createdAtIso: String): String {
        val safe = barcode.replace(Regex("[\\\\/:*?\"<>|\\s]"), "_").take(64)
        val time = DateTimeUtil.formatFull(createdAtIso).replace(":", "").replace(" ", "_")
        return "${safe}_第${seq}张_$time.jpg"
    }
}
