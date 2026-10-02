package com.xingqiyi.laundryphoto.ui.capture

import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.viewModelScope
import com.xingqiyi.laundryphoto.data.remote.ApiError
import com.xingqiyi.laundryphoto.di.AppContainer
import com.xingqiyi.laundryphoto.sync.SyncManager
import com.xingqiyi.laundryphoto.ui.base.BaseViewModel
import com.xingqiyi.laundryphoto.util.BarcodeUtil
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
 * 拍照录入。
 *
 * 与桌面端拍照页的能力对齐：条码 + 备注 + 拍摄 + 相似条码预警。
 * 移动端额外承担一件事——**拍照结果不能丢**。
 * 在线时直接上传；服务器不可达时把已处理好的照片落本机队列，
 * 并立刻入队补传任务，网络一恢复就自动上传（详见 SyncWorker）。
 */
class CaptureViewModel(private val container: AppContainer) : BaseViewModel() {

    val barcode = mutableStateOf("")
    val note = mutableStateOf("")
    val warning = mutableStateOf<BarcodeWarn?>(null)
    val previewPath = mutableStateOf<String?>(null)

    private val _cameraError = MutableStateFlow<String?>(null)
    val cameraError: StateFlow<String?> = _cameraError.asStateFlow()

    private val _saved = MutableSharedFlow<SaveResult>(extraBufferCapacity = 1)
    val saved: SharedFlow<SaveResult> = _saved.asSharedFlow()

    private var quality = 82

    /** 库中已有条码，用于扫码误读预警；取不到就静默关闭预警，不阻断拍照 */
    private var knownBarcodes: List<String> = emptyList()
    private var profile: BarcodeUtil.FormatProfile? = null

    init {
        viewModelScope.launch {
            quality = runCatching { container.settings.photoQuality.first() }.getOrDefault(82)
            runCatching { container.recordRepository.barcodes() }
                .onSuccess { knownBarcodes = it }
        }
    }

    fun onCameraError(message: String) {
        _cameraError.value = message
    }

    fun clearCameraError() {
        _cameraError.value = null
    }

    /** 条码变化时实时预警（与桌面端同样的判定口径） */
    fun onBarcodeChange(value: String) {
        barcode.value = value
        val v = value.trim()
        if (v.length < 6 || knownBarcodes.isEmpty()) {
            warning.value = null
            return
        }
        val suspicious = BarcodeUtil.hasSuspicious(v)
        val similar = BarcodeUtil.similarList(v, knownBarcodes)
        val prof = profile ?: BarcodeUtil.formatProfile(knownBarcodes).also { profile = it }
        val repaired = BarcodeUtil.repair(v, prof)
        warning.value = BarcodeWarn(
            suspicious = suspicious,
            similar = similar,
            suggestion = if (repaired.value != v) repaired.value else null,
            fixes = repaired.fixes
        )
    }

    fun applySuggestion(value: String) {
        onBarcodeChange(value)
    }

    /**
     * 处理刚拍到的原图：降采样 + 方向纠正 + 时间水印 + 压缩。
     * 处理完进入确认步骤（展示处理后的结果，而不是原图——
     * 用户看到的必须是将要存档的那张，否则水印位置/清晰度问题只能事后发现）。
     */
    fun processPhoto(rawPath: String) {
        launchSafe {
            val out = File(container.workDir, "preview_${System.currentTimeMillis()}.jpg")
            val result = ImageUtil.processCapture(
                srcPath = rawPath,
                outFile = out,
                watermark = DateTimeUtil.watermarkNow(),
                quality = quality
            )
            if (result == null) {
                emitToast("照片处理失败，请重新拍摄")
            } else {
                previewPath.value = result.absolutePath
            }
        }
    }

    fun retake() {
        previewPath.value?.let { runCatching { File(it).delete() } }
        previewPath.value = null
    }

    /** 保存：成功上传或成功入队都算「已保存」，差别只体现在提示语上 */
    fun confirm() {
        val b = barcode.value.trim()
        val n = note.value.trim()
        val path = previewPath.value
        when {
            b.isBlank() -> return emitToast("请填写衣物条形码")
            path == null -> return emitToast("请先拍摄照片")
        }
        launchSafe {
            val file = File(path)
            try {
                val rec = container.recordRepository.add(barcode = b, note = n, file = file, offlineSync = false)
                emitToast("已存档：${rec.barcode} 第 ${rec.seq} 张")
                _saved.tryEmit(SaveResult.Online(rec.barcode, rec.seq))
            } catch (e: ApiError.Network) {
                // 服务器不可达：照片已经在本地，入队即可，绝不能让店员的劳动白费
                val keep = File(container.workDir, "offline_${System.currentTimeMillis()}.jpg")
                file.copyTo(keep, overwrite = true)
                container.offlineRepository.enqueue(b, n, keep, DateTimeUtil.nowIso())
                keep.delete()
                SyncManager.enqueueImmediate(container.appContext)
                emitToast("服务器不可达，照片已存本机，联网后自动上传")
                _saved.tryEmit(SaveResult.Offline(b))
            }
            file.delete()
            previewPath.value = null
            note.value = ""
            // 条码保留：同一件衣物常常要拍多张，清空反而要反复重扫
        }
    }

    data class BarcodeWarn(
        val suspicious: Boolean,
        val similar: List<String>,
        val suggestion: String?,
        val fixes: List<String>
    )

    sealed class SaveResult {
        data class Online(val barcode: String, val seq: Int) : SaveResult()
        data class Offline(val barcode: String) : SaveResult()
    }
}
