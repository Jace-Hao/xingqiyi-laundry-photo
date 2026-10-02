package com.xingqiyi.laundryphoto.data.local

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

/**
 * 离线待上传存档。
 *
 * 与桌面端的 offline-queue.json 同职责：服务器失联时先把照片落在本地，恢复后按序补传。
 * 用 Room 而不是 JSON 文件，是因为移动端补传要跨进程/跨重启可靠执行（WorkManager 保证），
 * 文件的读写竞争与崩溃一致性都要自己处理，得不偿失。
 *
 * 注意：这里只存**待补传**的记录。正常的在线查询数据不落本地库——
 * 存档数据以服务端为准，本地缓存会与「唯一登录」「他人在别处删除」等场景冲突。
 */
@Entity(tableName = "pending_upload")
data class PendingUploadEntity(
    /** 本地生成的记录 id，补传成功后用于去重与回执 */
    @PrimaryKey val id: String,
    val barcode: String = "",
    val note: String = "",
    /** 本机油箱中的照片绝对路径（app 私有目录，卸载即清除） */
    val localPath: String = "",
    /** 拍摄时间 ISO 字符串，补传失败重排顺序用 */
    val createdAt: String = "",
    val retryCount: Int = 0,
    val lastError: String? = null,
    val status: String = STATUS_PENDING
) {
    companion object {
        /** 等待补传 */
        const val STATUS_PENDING = "pending"
        /** 正在上传（避免 WorkManager 并发重复取同一条） */
        const val STATUS_UPLOADING = "uploading"
        /** 多次失败，等待人工处理（界面会标红提示） */
        const val STATUS_FAILED = "failed"
    }

    val isFailed: Boolean get() = status == STATUS_FAILED
}

@Dao
interface PendingUploadDao {

    @Query("SELECT * FROM pending_upload ORDER BY createdAt ASC")
    fun observeAll(): Flow<List<PendingUploadEntity>>

    @Query("SELECT * FROM pending_upload ORDER BY createdAt ASC")
    suspend fun listAll(): List<PendingUploadEntity>

    /**
     * WorkManager 每轮只取一批，避免一次性把几十张照片塞进内存。
     * 这里不写默认参数：Room 对 Kotlin 默认参数的支持依赖生成重载，
     * 直接把状态常量内联进 SQL 更稳，也避免在 DAO 里引入默认值拼接的歧义。
     */
    @Query("SELECT * FROM pending_upload WHERE status != 'uploading' ORDER BY createdAt ASC LIMIT :limit")
    suspend fun take(limit: Int): List<PendingUploadEntity>

    @Query("SELECT COUNT(*) FROM pending_upload")
    suspend fun count(): Int

    /** 等待补传（不含正在上传的）数量，界面角标用 */
    @Query("SELECT COUNT(*) FROM pending_upload WHERE status != 'uploading'")
    suspend fun countWaiting(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(item: PendingUploadEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(items: List<PendingUploadEntity>)

    @Query("DELETE FROM pending_upload WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)

    @Query("DELETE FROM pending_upload")
    suspend fun clear()

    @Query("UPDATE pending_upload SET status = :status, retryCount = :retry, lastError = :error WHERE id = :id")
    suspend fun updateStatus(id: String, status: String, retry: Int, error: String?)
}

/**
 * 本地数据库。
 * version 1：初版仅含离线补传队列。后续如新增缓存表，需写 Migration。
 * exportSchema 关闭：移动端不涉及跨版本升级的复杂迁移（卸载重装即可），
 * 省去维护 schemas/ 目录与每次发版补齐 schema 文件的工作。
 */
@Database(entities = [PendingUploadEntity::class], version = 1, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun pendingUploadDao(): PendingUploadDao
}
