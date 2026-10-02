package com.xingqiyi.laundryphoto.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * 补传任务调度。
 *
 * 两个触发点，缺一不可：
 * - 一次性任务：网络刚恢复、或刚拍完一张离线照片时立刻跑一轮（用户能马上看到同步完成）；
 * - 周期任务：兜底。App 可能在整个离线期间都没被打开过，
 *   只靠「打开时触发」会让照片积压很久，因此再加一个 15 分钟的周期扫描
 *   （周期任务的最小间隔就是 15 分钟，这是系统限制）。
 *
 * 约束统一为「有网络」：离线补传本质上就是在等网络，没网络时跑起来只会白白重试。
 */
object SyncManager {

    private const val UNIQUE_ONE_TIME = "xqy_sync_once"
    private const val UNIQUE_PERIODIC = "xqy_sync_periodic"

    private fun constraints(): Constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    /** 立即补传一轮（有网络才执行）；同名的旧任务会被保留，避免并发重复上传 */
    fun enqueueImmediate(context: Context) {
        Notifier.ensureChannels(context)
        val req = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(constraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            UNIQUE_ONE_TIME,
            ExistingWorkPolicy.KEEP,
            req
        )
    }

    /** 周期兜底扫描 */
    fun enqueuePeriodic(context: Context) {
        Notifier.ensureChannels(context)
        val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            UNIQUE_PERIODIC,
            ExistingPeriodicWorkPolicy.KEEP,
            req
        )
    }

    /** 退出登录时取消：没有会话令牌，补传必然失败 */
    fun cancelAll(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.cancelUniqueWork(UNIQUE_ONE_TIME)
        wm.cancelUniqueWork(UNIQUE_PERIODIC)
    }
}
