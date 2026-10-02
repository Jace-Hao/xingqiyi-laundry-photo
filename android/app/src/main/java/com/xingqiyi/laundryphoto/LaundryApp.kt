package com.xingqiyi.laundryphoto

import android.app.Application
import com.xingqiyi.laundryphoto.di.AppContainer
import com.xingqiyi.laundryphoto.sync.Notifier

/**
 * Application 入口。
 * 只做一件事：持有依赖容器并创建通知渠道——不要在 Application 里做网络或数据库操作，
 * 启动路径上的任何阻塞都会直接体现在冷启动耗时上。
 */
class LaundryApp : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        // 渠道创建是幂等的，放在这里保证任何入口（含 WorkManager）发通知时渠道已存在
        Notifier.ensureChannels(this)
    }
}
