package com.xingqiyi.laundryphoto.ui.burst

import androidx.lifecycle.viewModelScope
import com.xingqiyi.laundryphoto.di.AppContainer
import com.xingqiyi.laundryphoto.sync.SyncManager
import com.xingqiyi.laundryphoto.ui.base.BaseViewModel
import com.xingqiyi.laundryphoto.util.BurstPhotoStore
import com.xingqiyi.laundryphoto.util.DateTimeUtil
import com.xingqiyi.laundryphoto.util.ImageUtil
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.io.File

/**
 * 扫码后的全屏连拍：拍一张→立刻存一张，退出时统一入队补传。
 *
 * ## 为什么「即时保存」而不是「拍完一起存」
 *
 * 连拍的现场是：店员一手拎着湿衣服、一手举着手机连按快门，
 * 中途随时可能来客人、手机没电、或者被系统回收。
 * 若把照片攒在内存里到最后统一写盘，一旦中途出事就是**整批全丢**，
 * 而店员没法重拍（衣服已经进洗衣机了）。
 * 因此每张拍完立刻落盘 + 更新张数，把丢失半径压到「最多丢一张」。
 *
 * ## 为什么上传放在「完成」而不是每张都传
 *
 * 上传要走局域网到桌面端，单张 1~2MB 在弱网下可能要几秒。
 * 每张都传会让快门变成「点一下卡三秒」，连拍体验彻底崩掉。
 * 所以本地保存与上传解耦：保存是同步感知的，上传是最后一次性入队，
 * 由 SyncWorker 在后台补传，失败自动重试。
 */
class BurstCaptureViewModel(
    private val container: AppContainer,
    val barcode: String
) : BaseViewModel() {

    /** 本批照片的存储目录，界面上要展示给用户 */
    val saveDir: String = BurstPhotoStore.dirFor(container.appContext, barcode).absolutePath

    private val dir = File(saveDir)

    /**
     * 起始序号：接着该条码已有的张数继续编号。
     * 这样同一件衣物上午拍 3 张、下午补拍 2 张，文件名不会撞车也不会跳号。
     */
    private val baseSeq: Int = BurstPhotoStore.existingCount(dir)

    private val saved = mutableListOf<File>()

    /** 最近一次拍摄的原图：保存失败时留着给「重试」用，成功后立即删除 */
    private var lastRawPath: String? = null

    private var quality = 82

    private val _shotCount = MutableStateFlow(0)
    val shotCount: StateFlow<Int> = _shotCount.asStateFlow()

    /** 保存失败的原因（可重试） */
    private val _saveError = MutableStateFlow<String?>(null)
    val saveError: StateFlow<String?> = _saveError.asStateFlow()

    /** 相册写入失败的提示：照片本身已存好，属于可降级失败 */
    private val _galleryHint = MutableStateFlow<String?>(null)
    val galleryHint: StateFlow<String?> = _galleryHint.asStateFlow()

    private val _writeGallery = MutableStateFlow(false)
    val writeGallery: StateFlow<Boolean> = _writeGallery.asStateFlow()

    private val _finished = MutableSharedFlow<Int>(extraBufferCapacity = 1)
    val finished: SharedFlow<Int> = _finished.asSharedFlow()

    init {
        viewModelScope.launch {
            // 读不到偏好就用默认 82：不能因为一个设置项读不出来就阻止拍照
            quality = runCatching { container.settings.photoQuality.first() }.getOrDefault(82)
        }
    }

    fun setWriteGallery(value: Boolean) {
        _writeGallery.value = value
    }

    fun clearSaveError() {
        _saveError.value = null
    }

    fun clearGalleryHint() {
        _galleryHint.value = null
    }

    /**
     * 相机回调：处理 + 落盘 + （可选）写入相册。
     * 失败时保留原图路径，界面上给「重试」。
     */
    fun onPhotoCaptured(rawPath: String) = launchSafe(setBusyState = true) {
        lastRawPath = rawPath
        _saveError.value = null
        if (persist(rawPath)) {
            // 成功不弹 toast：连拍时每一下都弹会盖住画面，张数角标已经足够反馈
            lastRawPath = null
        }
    }

    /**
     * 相机回调失败（快门按下但没出片）。
     * 复用保存错误的展示通道：对店员而言「没拍下来」和「没存下来」是同一件事，
     * 都是「这一张没了，得再拍一次」。
     */
    fun onCaptureError(message: String) {
        _saveError.value = if (message.isBlank()) "拍照失败，请重新拍摄这一张" else message
    }

    /** 重试用原图再走一次保存 */
    fun retrySave() = launchSafe(setBusyState = true) {
        val raw = lastRawPath
        if (raw == null) {
            emitToast("没有可重试的照片，请重拍")
            return@launchSafe
        }
        if (persist(raw)) {
            _saveError.value = null
            lastRawPath = null
            emitToast("已保存第 ${saved.size} 张")
        }
    }

    /**
     * 落盘一张。
     * @return 是否成功；失败时已把原因写入 [_saveError]
     */
    private fun persist(rawPath: String): Boolean {
        val raw = File(rawPath)
        if (!raw.exists() || raw.length() <= 0L) {
            _saveError.value = "相机没有产出图片，请重新拍摄这一张"
            return false
        }

        val seq = baseSeq + saved.size + 1
        val out = File(dir, BurstPhotoStore.fileNameOf(barcode, seq, DateTimeUtil.nowIso()))

        return try {
            val processed = ImageUtil.processCapture(
                srcPath = rawPath,
                outFile = out,
                watermark = DateTimeUtil.watermarkNow(),
                quality = quality
            )
            if (processed == null) {
                _saveError.value = "照片处理失败（内存不足或图片损坏），请重拍这一张"
                return false
            }

            if (_writeGallery.value) {
                val ok = BurstPhotoStore.writeToGallery(
                    container.appContext,
                    processed,
                    processed.name
                )
                if (!ok) {
                    // 降级而非失败：照片本身已安全落盘，只是没进相册
                    _galleryHint.value =
                        "照片已存入应用目录，但写入系统相册失败（Android 9 及以下需要存储权限）"
                }
            }

            saved.add(processed)
            _shotCount.value = saved.size
            raw.delete()
            true
        } catch (e: OutOfMemoryError) {
            _saveError.value = "内存不足，照片未保存。请先退出其它应用再重拍这一张"
            false
        } catch (e: SecurityException) {
            _saveError.value = "没有写入存储的权限，照片未保存"
            false
        } catch (e: java.io.IOException) {
            _saveError.value = "存储空间不足或磁盘错误，照片未保存：${e.message ?: "未知原因"}"
            false
        } catch (e: Throwable) {
            _saveError.value = "保存失败：${e.message ?: "未知原因"}"
            false
        }
    }

    /**
     * 完成：把所有已存照片一次性入队补传。
     *
     * 走离线队列而不是直接调上传接口，是为了让「在线/离线」两种情况下
     * 行为完全一致：成功与否由 SyncWorker 负责重试，界面不用管网络状态。
     */
    fun finish() = launchSafe {
        if (saved.isEmpty()) {
            emitToast("还没有拍照片")
            return@launchSafe
        }
        val files = saved.toList()
        var queued = 0
        for (f in files) {
            runCatching {
                container.offlineRepository.enqueue(
                    barcode = barcode,
                    note = "",
                    sourceFile = f,
                    createdAtIso = DateTimeUtil.nowIso()
                )
            }.onSuccess { queued++ }
        }
        SyncManager.enqueueImmediate(container.appContext)
        emitToast(
            if (queued == files.size) "已保存 $queued 张，正在上传到服务端"
            else "已入队 $queued/${files.size} 张，失败的稍后可在首页重试同步"
        )
        _finished.tryEmit(queued)
    }
}
