package com.xingqiyi.laundryphoto.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import com.xingqiyi.laundryphoto.R

/**
 * 通知封装。
 *
 * Android 8.0 起通知必须归属渠道，且渠道一旦创建其重要性就由用户掌控，
 * 因此这里只在首次使用时创建、之后复用（重复创建无效但会触发一次系统写入，没必要）。
 *
 * 分两个渠道是有意为之：
 * - 同步进度属于「低打扰」，默认 IMPORTANCE_LOW，不响铃不震动；
 * - 账号被顶下线/强制更新属于「必须看见」，用 DEFAULT 重要性。
 * 混在一个渠道里，用户一旦关掉就什么都收不到了。
 */
object Notifier {

    const val CHANNEL_SYNC = "xqy_sync"
    const val CHANNEL_ALERT = "xqy_alert"

    private const val ID_SYNC_PROGRESS = 2001
    private const val ID_SYNC_DONE = 2002
    private const val ID_SYNC_FAILED = 2003
    private const val ID_ALERT = 2004
    private const val ID_FORCE_UPDATE = 2005

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CHANNEL_SYNC) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_SYNC,
                    context.getString(R.string.channel_sync_name),
                    NotificationManager.IMPORTANCE_LOW
                ).apply { description = context.getString(R.string.channel_sync_desc) }
            )
        }
        if (mgr.getNotificationChannel(CHANNEL_ALERT) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ALERT,
                    context.getString(R.string.channel_alert_name),
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply { description = context.getString(R.string.channel_alert_desc) }
            )
        }
    }

    private fun manager(context: Context): NotificationManager? =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager

    /** 补传进度：同一 id 反复更新，避免刷出一串通知 */
    fun notifySyncProgress(context: Context, current: Int, total: Int) {
        val n = NotificationCompat.Builder(context, CHANNEL_SYNC)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("正在补传离线照片")
            .setContentText("$current / $total")
            .setProgress(total, current, false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
        manager(context)?.notify(ID_SYNC_PROGRESS, n)
    }

    fun notifySyncDone(context: Context, count: Int) {
        manager(context)?.cancel(ID_SYNC_PROGRESS)
        if (count <= 0) return
        val n = NotificationCompat.Builder(context, CHANNEL_SYNC)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("离线照片已同步")
            .setContentText("已上传 $count 张离线拍摄的照片到服务器")
            .setAutoCancel(true)
            .build()
        manager(context)?.notify(ID_SYNC_DONE, n)
    }

    fun notifySyncFailed(context: Context, count: Int, reason: String) {
        manager(context)?.cancel(ID_SYNC_PROGRESS)
        val n = NotificationCompat.Builder(context, CHANNEL_ALERT)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("有 $count 张离线照片未同步")
            .setContentText(reason)
            .setAutoCancel(true)
            .build()
        manager(context)?.notify(ID_SYNC_FAILED, n)
    }

    /** 账号被顶下线：属于必须看见的提醒，点开回到 App 即可看到登录页 */
    fun notifySessionRevoked(context: Context, message: String) {
        val n = NotificationCompat.Builder(context, CHANNEL_ALERT)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("账号已退出登录")
            .setContentText(message)
            .setAutoCancel(true)
            .build()
        manager(context)?.notify(ID_ALERT, n)
    }

    fun notifyForceUpdate(context: Context, version: String) {
        val n = NotificationCompat.Builder(context, CHANNEL_ALERT)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("服务端要求更新到 v$version")
            .setContentText("请联系管理员获取安装包后重新安装")
            .setAutoCancel(true)
            .build()
        manager(context)?.notify(ID_FORCE_UPDATE, n)
    }
}
