package com.xingqiyi.laundryphoto.data.repository

import android.util.Base64
import com.xingqiyi.laundryphoto.data.model.DeleteBatchResult
import com.xingqiyi.laundryphoto.data.model.Paged
import com.xingqiyi.laundryphoto.data.model.RecordDto
import com.xingqiyi.laundryphoto.data.model.RenameBatchResult
import com.xingqiyi.laundryphoto.data.remote.ApiClient
import com.xingqiyi.laundryphoto.data.remote.ApiError
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File

/**
 * 衣物照片存档仓库。
 *
 * 上传策略（移动端特有）：
 * - 服务端支持 uploadRaw 时走「原始二进制暂存 → 凭文件名建档」两步，
 *   弱网下只重传一个文件，比 base64 省掉 33% 体积膨胀与整包内存占用；
 * - 老服务端（接口不存在）自动回退 base64 通道，对使用者无感。
 */
class RecordRepository(private val api: ApiClient) {

    /** 查询条件；与服务端 records/list 的参数一一对应 */
    data class Query(
        val keyword: String = "",
        val barcode: String = "",
        val dateFrom: String = "",
        val dateTo: String = "",
        val page: Int = 1,
        val pageSize: Int = 20,
        /** 系统管理员可用：按账号 / 门店过滤 */
        val userId: String = "",
        val storeFilter: String = "",
        /** 静默查询：不写操作日志（轮询/刷新用，避免把日志刷爆） */
        val silent: Boolean = false
    )

    suspend fun list(query: Query): Paged<RecordDto> = api.request { svc ->
        svc.listRecords(
            mapOf(
                "keyword" to query.keyword.ifBlank { null },
                "barcode" to query.barcode.ifBlank { null },
                "dateFrom" to query.dateFrom.ifBlank { null },
                "dateTo" to query.dateTo.ifBlank { null },
                "userId" to query.userId.ifBlank { null },
                "storeFilter" to query.storeFilter.ifBlank { null },
                "page" to query.page,
                "pageSize" to query.pageSize,
                "silent" to query.silent
            )
        )
    }

    suspend fun get(id: String): RecordDto = api.request { svc ->
        svc.getRecord(mapOf("id" to id))
    }

    suspend fun delete(id: String) {
        api.requestUnit { it.deleteRecord(mapOf("id" to id)) }
    }

    suspend fun deleteBatch(ids: List<String>): DeleteBatchResult = api.request { svc ->
        svc.deleteRecords(mapOf("ids" to ids))
    }

    suspend fun renameBarcode(id: String, newBarcode: String): RecordDto = api.request { svc ->
        svc.renameBarcode(mapOf("id" to id, "barcode" to newBarcode))
    }

    suspend fun renameBarcodeBatch(ids: List<String>, newBarcode: String): RenameBatchResult = api.request { svc ->
        svc.renameBarcodeBatch(mapOf("ids" to ids, "barcode" to newBarcode))
    }

    /** 库中全部已存档条码（用于拍照页相似条码预警） */
    suspend fun barcodes(): List<String> = api.request { svc ->
        svc.listBarcodes(emptyMap())
    }

    /** 备注订正；服务端不支持时（老版本）抛 Unsupported，界面据此隐藏入口 */
    suspend fun setNote(id: String, note: String): RecordDto = api.request { svc ->
        svc.setRecordNote(mapOf("id" to id, "note" to note))
    }

    /**
     * 上传并建档。
     *
     * @param file 已压缩加水印的本地照片
     * @param offlineSync 是否来自离线补传（服务端据此在日志中标注）
     */
    suspend fun add(barcode: String, note: String, file: File, offlineSync: Boolean = false): RecordDto {
        val caps = api.capabilities
        if (caps == null || caps.uploadRaw) {
            return try {
                addByFile(barcode, note, file, offlineSync)
            } catch (e: ApiError.Unsupported) {
                // 服务端声明支持但实际没有该接口（版本错配）：静默回退，不让用户看到内部错误
                addByBase64(barcode, note, file)
            }
        }
        return addByBase64(barcode, note, file)
    }

    private suspend fun addByFile(
        barcode: String,
        note: String,
        file: File,
        offlineSync: Boolean
    ): RecordDto {
        val bytes = file.readBytes()
        val body = bytes.toRequestBody("image/jpeg".toMediaType(), 0, bytes.size)
        val uploaded = api.request { svc -> svc.uploadPhoto(file.name, body) }
        return api.request { svc ->
            svc.addRecordByFile(
                mapOf(
                    "barcode" to barcode,
                    "note" to note,
                    "photoFile" to uploaded.photoFile,
                    "offlineSync" to offlineSync
                )
            )
        }
    }

    private suspend fun addByBase64(barcode: String, note: String, file: File): RecordDto {
        val bytes = file.readBytes()
        // NO_WRAP 不可省：Base64.DEFAULT 会插入换行符，服务端按单行解析会得到损坏的图片
        val data = "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
        return api.request { svc ->
            svc.addRecord(mapOf("barcode" to barcode, "note" to note, "imageData" to data))
        }
    }

    /** 原图地址（详情查看/保存用） */
    fun photoUrl(record: RecordDto): String = api.photoUrl(record.photoFile)

    /** 缩略图地址（网格用）；服务端不支持缩略图时自动回退原图 */
    fun thumbUrl(record: RecordDto, width: Int = 360): String =
        api.photoUrl(record.photoFile, if (api.capabilities?.thumb != false) width else null)
}
