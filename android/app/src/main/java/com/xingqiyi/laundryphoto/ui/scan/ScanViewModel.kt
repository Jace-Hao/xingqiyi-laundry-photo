package com.xingqiyi.laundryphoto.ui.scan

import com.xingqiyi.laundryphoto.ui.base.BaseViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * 扫码页状态机。
 *
 * 刻意做成「无网络、无仓库依赖」的纯状态机：
 * 扫码这件事本身不产生任何服务端交互，识别到的码值只是**传给拍照页的一个参数**。
 * 少一层依赖就少一处「页面还没进就已经在请求网络」的意外。
 */
class ScanViewModel : BaseViewModel() {

    private val _detected = MutableStateFlow<String?>(null)
    val detected: StateFlow<String?> = _detected.asStateFlow()

    /** 超过 [NO_RESULT_TIMEOUT_MS] 仍未识别到任何码 */
    private val _noResult = MutableStateFlow(false)
    val noResult: StateFlow<Boolean> = _noResult.asStateFlow()

    private val _cameraError = MutableStateFlow<String?>(null)
    val cameraError: StateFlow<String?> = _cameraError.asStateFlow()

    /**
     * 识别轮次。自增即代表「重新开始一轮」，
     * 页面据此重建倒计时、并复位分析器的一次性命中标记。
     */
    private val _attempt = MutableStateFlow(0)
    val attempt: StateFlow<Int> = _attempt.asStateFlow()

    /**
     * 识别成功。
     *
     * 只认第一次：分析器命中后就会停止工作，但回调仍可能因为帧已在途中而重复到达，
     * 不加重入保护的话会出现「跳两次拍照页」或「第二次扫到旁边衣服的码把第一次覆盖」。
     */
    fun onDetected(value: String) {
        if (_detected.value != null) return
        val v = value.trim()
        if (v.isEmpty()) return
        _detected.value = v
        _noResult.value = false
    }

    /** 页面侧的超时回调：确实扫了很久还没结果，此时才提示，避免一进页面就催用户 */
    fun onNoResultTimeout() {
        if (_detected.value == null) _noResult.value = true
    }

    /** 用户点「重新识别」 */
    fun retry() {
        _detected.value = null
        _noResult.value = false
        _cameraError.value = null
        _attempt.value += 1
    }

    fun onCameraError(message: String) {
        _cameraError.value = message
    }

    fun clearCameraError() {
        _cameraError.value = null
    }

    companion object {
        /**
         * 无结果提示阈值。
         * 定 12 秒而不是 3 秒：店员通常一手拎着衣服一手拿手机，
         * 对准动作本身就要好几秒，提示太早会变成噪音，反而让人忽略真正的提示。
         */
        const val NO_RESULT_TIMEOUT_MS = 12_000L
    }
}
