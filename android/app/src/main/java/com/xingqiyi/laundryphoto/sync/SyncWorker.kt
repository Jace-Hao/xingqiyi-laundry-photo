package com.xingqiyi.laundryphoto.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.xingqiyi.laundryphoto.LaundryApp
import com.xingqiyi.laundryphoto.data.local.PendingUploadEntity
import com.xingqiyi.laundryphoto.data.remote.ApiError
import com.xingqiyi.laundryphoto.data.repository.RecordRepository
import java.io.File

/**
 * 离线照片补传。
 *
 * 为什么用 WorkManager 而不是在页面里起协程：
 * 离线照片可能在用户关掉 App、甚至重启手机之后才等到网络恢复，
 * 页面作用域的协程在进程被回收时就没了，照片会永远卡在队列里。
 * WorkManager 保证「即使进程被杀也会在约束满足后重新执行」。
 *
 * 失败处理分三类，区别对待是重点：
 * - 网络类：重试（指数退避，交给 WorkManager）；
 * - 业务类（条码非法、无权限等）：重试一万次也不会成功，直接标记失败等人处理；
 * - 会话被顶下线：必须停止整轮并通知用户重新登录，否则会在无权限的情况下反复撞墙。
 */
class SyncWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {

    /** 连续失败多少次后标记为「需人工处理」 */
    private companion object {
        const val MAX_RETRY = 5
        const val BATCH = 10
    }

    override suspend fun doWork(): Result {
        val app = applicationContext as? LaundryApp ?: return Result.failure()
        val container = app.container
        // 工作进程里没有登录态，令牌必须重新从本机设置恢复
        container.ensureConfigured()

        val offline = container.offlineRepository
        val records = container.recordRepository

        val items = offline.take(BATCH)
        if (items.isEmpty()) return Result.success()

        var synced = 0
        var stoppedBySession = false
        var lastError: String? = null

        Notifier.notifySyncProgress(applicationContext, 0, items.size)

        for ((index, item) in items.withIndex()) {
            val file = File(item.localPath)
            // 照片文件已被清理（用户手动清了缓存/重装后残留记录）：出队即可，不必重试
            if (!file.exists()) {
                offline.remove(listOf(item.id))
                continue
            }
            offline.markUploading(item.id)
            try {
                records.add(barcode = item.barcode, note = item.note, file = file, offlineSync = true)
                offline.remove(listOf(item.id))
                // 补传成功后本地副本失去意义，删除避免占空间、也避免被当成「还有未同步照片」
                file.delete()
                synced++
            } catch (e: ApiError.SessionRevoked) {
                offline.markPending(item.id, item.retryCount, e.message)
                lastError = e.message
                stoppedBySession = true
                break
            } catch (e: ApiError.Network) {
                val retry = item.retryCount + 1
                lastError = e.message
                if (retry >= MAX_RETRY) offline.markFailed(item.id, retry, e.message)
                else offline.markPending(item.id, retry, e.message)
            } catch (e: ApiError.Auth) {
                // 连接码失效：必须人工介入（回到 App 重新配置），重试无意义
                offline.markFailed(item.id, item.retryCount + 1, e.message)
                lastError = e.message
                break
            } catch (e: ApiError) {
                // 业务错误（条码非法、无拍照权限等）：重试不会改变结果
                offline.markFailed(item.id, item.retryCount + 1, e.message)
                lastError = e.message
            }
            Notifier.notifySyncProgress(applicationContext, index + 1, items.size)
        }

        val remaining = offline.countWaiting()

        if (stoppedBySession) {
            Notifier.notifySessionRevoked(applicationContext, lastError ?: "账号已在其他设备登录")
            return Result.failure()
        }

        if (synced > 0) {
            Notifier.notifySyncDone(applicationContext, synced)
            container.settings.markSynced()
        }
        if (remaining > 0) {
            Notifier.notifySyncFailed(
                applicationContext,
                remaining,
                lastError ?: "将在网络恢复后继续重试"
            )
            // 队列还没清空：交给 WorkManager 按退避策略重试
            return Result.retry()
        }
        return Result.success()
    }
}
