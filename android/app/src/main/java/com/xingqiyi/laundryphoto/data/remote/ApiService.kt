package com.xingqiyi.laundryphoto.data.remote

import com.xingqiyi.laundryphoto.data.model.ApiEnvelope
import com.xingqiyi.laundryphoto.data.model.CapabilitiesDto
import com.xingqiyi.laundryphoto.data.model.DeleteBatchResult
import com.xingqiyi.laundryphoto.data.model.ForceUpdateDto
import com.xingqiyi.laundryphoto.data.model.LogEntryDto
import com.xingqiyi.laundryphoto.data.model.LoginResult
import com.xingqiyi.laundryphoto.data.model.OverviewDto
import com.xingqiyi.laundryphoto.data.model.Paged
import com.xingqiyi.laundryphoto.data.model.RecordDto
import com.xingqiyi.laundryphoto.data.model.RenameBatchResult
import com.xingqiyi.laundryphoto.data.model.SystemInfoDto
import com.xingqiyi.laundryphoto.data.model.UpdateInfoDto
import com.xingqiyi.laundryphoto.data.model.UploadResult
import com.xingqiyi.laundryphoto.data.model.UserDto
import okhttp3.RequestBody
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST

/**
 * 服务端 HTTP 接口。
 *
 * 路径与桌面端 main/server.js 的 routes 表一一对应（除移动端新增的三个接口外）。
 * 请求体统一用 Map：服务端各接口的参数是扁平且经常增量加字段的，
 * 用 Map 可以避免为每个可选字段建一个 data class，也避免漏传/多传导致服务端判定异常。
 * Gson 默认跳过 null 值，语义等同于桌面端 JS 里「不传该字段」。
 */
interface ApiService {

    // ---------- 认证 ----------
    @POST("api/auth/login")
    suspend fun login(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<LoginResult>

    @POST("api/auth/logout")
    suspend fun logout(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<Any?>

    @POST("api/auth/current")
    suspend fun current(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<UserDto>

    @POST("api/auth/changePassword")
    suspend fun changePassword(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<Any?>

    // ---------- 衣物存档 ----------
    @POST("api/records/list")
    suspend fun listRecords(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<Paged<RecordDto>>

    /** base64 建档：兼容通道，弱网或大照片时优先走 [uploadPhoto] + [addRecordByFile] */
    @POST("api/records/add")
    suspend fun addRecord(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<RecordDto>

    @POST("api/records/get")
    suspend fun getRecord(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<RecordDto>

    @POST("api/records/delete")
    suspend fun deleteRecord(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<Any?>

    @POST("api/records/deleteBatch")
    suspend fun deleteRecords(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<DeleteBatchResult>

    @POST("api/records/barcodes")
    suspend fun listBarcodes(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<List<String>>

    @POST("api/records/renameBarcode")
    suspend fun renameBarcode(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<RecordDto>

    @POST("api/records/renameBarcodeBatch")
    suspend fun renameBarcodeBatch(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<RenameBatchResult>

    // 移动端新增（v1.3.0）：原始二进制上传 + 凭暂存文件建档 + 备注订正
    @POST("upload")
    suspend fun uploadPhoto(
        @Header("x-file-name") fileName: String,
        @Body body: RequestBody
    ): ApiEnvelope<UploadResult>

    @POST("api/records/addByFile")
    suspend fun addRecordByFile(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<RecordDto>

    @POST("api/records/setNote")
    suspend fun setRecordNote(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<RecordDto>

    // ---------- 用户管理 ----------
    @POST("api/users/list")
    suspend fun listUsers(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<List<UserDto>>

    @POST("api/users/create")
    suspend fun createUser(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<UserDto>

    @POST("api/users/update")
    suspend fun updateUser(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<UserDto>

    @POST("api/users/delete")
    suspend fun deleteUser(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<Any?>

    // ---------- 日志与总览 ----------
    @POST("api/logs/list")
    suspend fun listLogs(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<Paged<LogEntryDto>>

    @POST("api/logs/actionOptions")
    suspend fun logActionOptions(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<List<String>>

    @POST("api/logs/filterUsers")
    suspend fun logFilterUsers(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<List<UserDto>>

    @POST("api/stats/overview")
    suspend fun overview(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<OverviewDto>

    // ---------- 系统 ----------
    @POST("api/system/info")
    suspend fun systemInfo(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<SystemInfoDto>

    @POST("api/system/capabilities")
    suspend fun capabilities(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<CapabilitiesDto>

    @POST("api/system/forceUpdate")
    suspend fun forceUpdate(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<ForceUpdateDto?>

    @POST("api/system/checkUpdate")
    suspend fun checkUpdate(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<UpdateInfoDto>

    @POST("api/system/settings")
    suspend fun updateSystemSettings(@Body body: Map<String, @JvmSuppressWildcards Any?>): ApiEnvelope<Any?>

    /** 免鉴权探活：返回 app + 能力集，配置服务器地址时先 ping 一次 */
    @GET("ping")
    suspend fun ping(): ApiEnvelope<CapabilitiesDto>
}
