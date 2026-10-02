package com.xingqiyi.laundryphoto.data.repository

import com.xingqiyi.laundryphoto.data.local.PendingUploadEntity
import com.xingqiyi.laundryphoto.data.local.AppDatabase
import kotlinx.coroutines.flow.Flow
import java.io.File
import java.util.UUID

/**
 * 离线存档队列仓库（对应桌面端的 offline-queue.json）。
 *
 * 触发场景：拍照时服务器不可达（门店网络抖动、服务端没开机）。
 * 此时照片必须**不能丢**——店员已经把衣物收进去了，照片就是唯一的凭证，
 * 因此先落本地 + 入队，再由 WorkManager 在网络恢复后补传。
 *
 * 照片放在 app 私有目录（卸载即清除）。这是刻意的：
 * 补传成功后照片的唯一权威副本在服务端，留在公共相册会造成重复与隐私外泄。
 */
class OfflineRepository(
    private val db: AppDatabase,
    private val baseDir: File
) {
    private val dao = db.pendingUploadDao()

    /** 离线照片存放目录 */
    val pendingDir: File = File(baseDir, "pending").apply { mkdirs() }

    fun observe(): Flow<List<PendingUploadEntity>> = dao.observeAll()

    suspend fun count(): Int = dao.count()

    suspend fun countWaiting(): Int = dao.countWaiting()

    /**
     * 入队一张离线照片。
     * @param sourceFile 已压缩加水印的照片（会从原位置复制到离线目录，源文件可随后删除）
     */
    suspend fun enqueue(
        barcode: String,
        note: String,
        sourceFile: File,
        createdAtIso: String
    ): PendingUploadEntity {
        val id = UUID.randomUUID().toString()
        val dst = File(pendingDir, "$id.jpg")
        sourceFile.copyTo(dst, overwrite = true)
        val entity = PendingUploadEntity(
            id = id,
            barcode = barcode,
            note = note,
            localPath = dst.absolutePath,
            createdAt = createdAtIso
        )
        dao.upsert(entity)
        return entity
    }

    /** 取一批待补传记录（跳过正在上传的，避免并发重复上传同一张） */
    suspend fun take(limit: Int = 10): List<PendingUploadEntity> = dao.take(limit)

    suspend fun markUploading(id: String) {
        dao.updateStatus(id, PendingUploadEntity.STATUS_UPLOADING, 0, null)
    }

    suspend fun markPending(id: String, retry: Int, error: String?) {
        dao.updateStatus(id, PendingUploadEntity.STATUS_PENDING, retry, error)
    }

    /** 多次失败后标记为 failed：不再自动重试，由界面提示人工处理，避免无限重试刷爆服务端 */
    suspend fun markFailed(id: String, retry: Int, error: String?) {
        dao.updateStatus(id, PendingUploadEntity.STATUS_FAILED, retry, error)
    }

    suspend fun remove(ids: List<String>) {
        dao.deleteByIds(ids)
    }

    /** 清空队列与对应的照片文件（设置页「放弃未同步照片」用，需二次确认） */
    suspend fun clearAll() {
        dao.clear()
        pendingDir.deleteRecursively()
        pendingDir.mkdirs()
    }

    /** 恢复失败项为待上传，供界面「重试」按钮使用 */
    suspend fun retryFailed() {
        for (item in dao.listAll()) {
            if (item.isFailed) dao.updateStatus(item.id, PendingUploadEntity.STATUS_PENDING, 0, null)
        }
    }
}
