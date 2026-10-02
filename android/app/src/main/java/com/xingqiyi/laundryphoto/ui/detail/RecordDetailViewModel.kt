package com.xingqiyi.laundryphoto.ui.detail

import androidx.lifecycle.viewModelScope
import com.xingqiyi.laundryphoto.data.model.RecordDto
import com.xingqiyi.laundryphoto.data.remote.ApiError
import com.xingqiyi.laundryphoto.di.AppContainer
import com.xingqiyi.laundryphoto.ui.base.BaseViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * 存档详情。
 *
 * 详情接口本身会写一条「查看记录」的操作日志（服务端行为，与桌面端一致），
 * 因此这里不做轮询、也不在返回时重新拉取——每次进入只查一次，
 * 避免用户上下翻照片时把日志刷成一片「查看记录」。
 */
class RecordDetailViewModel(private val container: AppContainer) : BaseViewModel() {

    private val _record = MutableStateFlow<RecordDto?>(null)
    val record: StateFlow<RecordDto?> = _record.asStateFlow()

    private val _deleted = MutableSharedFlow<Boolean>(extraBufferCapacity = 1)
    val deleted: SharedFlow<Boolean> = _deleted.asSharedFlow()

    private val _changed = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val changed: SharedFlow<String> = _changed.asSharedFlow()

    fun load(id: String) {
        launchSafe(setBusyState = false) {
            val r = container.recordRepository.get(id)
            _record.value = r
        }
    }

    fun delete() {
        val r = _record.value ?: return
        launchSafe {
            container.recordRepository.delete(r.id)
            _deleted.tryEmit(true)
        }
    }

    fun rename(newBarcode: String) {
        val r = _record.value ?: return
        val v = newBarcode.trim()
        if (v.isBlank()) {
            emitToast("请填写新条码")
            return
        }
        if (v == r.barcode) {
            emitToast("新条码与原条码相同")
            return
        }
        launchSafe {
            val updated = container.recordRepository.renameBarcode(r.id, v)
            _record.value = updated
            _changed.tryEmit("已改码为 ${updated.barcode}")
        }
    }

    /**
     * 修改备注。
     * 老版本服务端没有该接口时返回 Unsupported，这里转成一句人话提示，
     * 而不是抛「接口不存在」这种对用户毫无意义的文案。
     */
    fun setNote(note: String) {
        val r = _record.value ?: return
        launchSafe {
            try {
                val updated = container.recordRepository.setNote(r.id, note.trim())
                _record.value = updated
                _changed.tryEmit("备注已更新")
            } catch (e: ApiError.Unsupported) {
                emitToast("当前服务端版本不支持修改备注，请在电脑上修改")
            }
        }
    }

    fun photoUrl(): String {
        val r = _record.value ?: return ""
        return container.recordRepository.photoUrl(r)
    }

    fun refresh(id: String) {
        viewModelScope.launch { runCatching { container.recordRepository.get(id) } }
    }
}
