package com.xingqiyi.laundryphoto.util

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import java.io.File

/**
 * 连拍照片的本地存储。
 *
 * ## 存储路径（明确约定）
 *
 * ```
 * /data/data/<包名>/files/photos/<安全条码>/<条码>_第N张_<时间>.jpg
 * ```
 * 即应用私有目录，**不需要任何存储权限**，卸载时随应用一起清除。
 *
 * 为什么不像很多相册类 App 那样直接写公共目录：
 * - Android 10 起分区存储，写公共目录只能走 MediaStore；
 *   Android 13 又引入细粒度媒体权限，三个版本三种写法；
 * - 这些照片是**衣物存档凭证**而非店员的个人照片，散落到个人相册里
 *   既无必要，也存在把客户衣物照片泄漏到社交分享里的风险。
 *
 * 因此默认只写私有目录；「同时存入相册」是显式开关，默认关闭，
 * 由店员按需开启（例如需要立刻发微信给客户时）。
 *
 * ## 命名规则
 *
 * 与 `PhotoSaver.fileNameOf` 完全一致（下载与拍摄共用一套命名，避免两处口径不一）：
 * `条码_第N张_YYYY-MM-DD_HHmmss.jpg`，其中 N 是**本次连拍的序号**，
 * 且会自动接着该条码目录下已有的张数继续编号，避免同一件衣物分两批拍时序号重复。
 */
object BurstPhotoStore {

    /** 私有根目录下的子目录名 */
    private const val ROOT = "photos"

    /** 相册子目录名（仅开启「存入相册」时使用） */
    private const val ALBUM = "星期衣"

    fun rootDir(context: Context): File = File(context.filesDir, ROOT)

    /**
     * 某个条码的照片目录（不存在则创建）。
     * @param barcode 原始条码：会做安全化处理，避免条码里的斜杠把目录写到别处去
     */
    fun dirFor(context: Context, barcode: String): File {
        val dir = File(rootDir(context), safeName(barcode))
        dir.mkdirs()
        return dir
    }

    /** 已存张数：用于接着编号。目录不存在或读取失败时返回 0（不阻断拍照） */
    fun existingCount(dir: File): Int = runCatching {
        dir.listFiles { f -> f.isFile && f.extension.equals("jpg", ignoreCase = true) }?.size ?: 0
    }.getOrDefault(0)

    /** 文件名，见类注释「命名规则」 */
    fun fileNameOf(barcode: String, seq: Int, createdAtIso: String): String =
        PhotoSaver.fileNameOf(barcode, seq, createdAtIso)

    /**
     * 路径安全化：只保留字母数字、下划线、连字符与中文，其余（含 `/`、`..`）一律替换。
     *
     * 条码来自扫码识别，理论上是外部输入；不做这层处理，
     * 一个含 `../../` 的畸形二维码就能把文件写到私有目录之外。
     */
    fun safeName(barcode: String): String =
        barcode.replace(Regex("[^A-Za-z0-9_\\-\\u4e00-\\u9fa5]"), "_")
            .trim('_')
            .ifEmpty { "未命名" }
            .take(64)

    /**
     * 把已保存的照片**额外**写一份到系统相册。
     *
     * 版本分支（这是「兼顾不同安卓版本」的核心差异点）：
     * - **Android 10（API 29）+**：用 `RELATIVE_PATH` 指定子目录，
     *   不需要任何存储权限；写完把 `IS_PENDING` 置 0，否则相册里会出现一个 0 字节占位图。
     * - **Android 9（API 28）-**：只能用已废弃的 `MediaStore.Images.Media.insertImage`，
     *   且需要 `WRITE_EXTERNAL_STORAGE` 运行时权限（Manifest 里已用 `maxSdkVersion=28` 封死，
     *   不会在高版本上白要权限）。没授权时返回 false，由调用方提示。
     *
     * @return 是否写入成功。**不抛异常**：保存失败要能被降级成「照片仍在应用内」，
     *         而不是让整个连拍流程中断。
     */
    fun writeToGallery(context: Context, file: File, displayName: String): Boolean {
        if (!file.exists() || file.length() <= 0L) return false
        return runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                writeToGalleryQ(context, file, displayName)
            } else {
                writeToGalleryLegacy(context, file, displayName)
            }
        }.getOrDefault(false)
    }

    private fun writeToGalleryQ(context: Context, file: File, displayName: String): Boolean {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$ALBUM")
            // IS_PENDING=1：写入期间对其它应用不可见，避免相册里出现半张图
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: return false
        return try {
            resolver.openOutputStream(uri)?.use { out ->
                file.inputStream().use { it.copyTo(out) }
            } ?: return false
            // 写完了才公开，失败时这条记录会被系统回收
            val done = ContentValues().apply {
                put(MediaStore.Images.Media.IS_PENDING, 0)
            }
            resolver.update(uri, done, null, null)
            true
        } catch (e: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            false
        }
    }

    @Suppress("DEPRECATION")
    private fun writeToGalleryLegacy(context: Context, file: File, displayName: String): Boolean {
        // 老路径需要 WRITE_EXTERNAL_STORAGE；未授权时 insertImage 会抛 SecurityException，
        // 由外层 runCatching 兜住并返回 false
        val url = MediaStore.Images.Media.insertImage(
            context.contentResolver,
            file.absolutePath,
            displayName,
            null
        )
        return !url.isNullOrBlank()
    }

    /** 供界面显示的 MIME 类型（分享/预览用） */
    fun mimeOf(file: File): String =
        MimeTypeMap.getSingleton()
            .getMimeTypeFromExtension(file.extension.lowercase())
            ?: "image/jpeg"
}
