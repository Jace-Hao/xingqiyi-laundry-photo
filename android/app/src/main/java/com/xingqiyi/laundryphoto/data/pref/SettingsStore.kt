package com.xingqiyi.laundryphoto.data.pref

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.xingqiyi.laundryphoto.data.model.SessionSnapshot
import com.xingqiyi.laundryphoto.data.model.UserDto
import com.xingqiyi.laundryphoto.util.PasswordCipher
import com.google.gson.Gson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.io.IOException

private val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore(name = "xqy_settings")

/**
 * 本机偏好设置（DataStore）。
 *
 * 对应桌面端的 config.json + credentials 模块：
 * - 服务器地址/连接码：桌面端由管理员在「启动设置」里填，移动端是每位店员各自配置，
 *   且**永不回传服务端**（与桌面端 credentials 不经 remoteCall 的设计一致）；
 * - 会话快照：登录态持久化，冷启动免登录；
 * - 记住的账号密码：密文存储，见 [PasswordCipher]。
 */
class SettingsStore(
    private val context: Context,
    private val cipher: PasswordCipher = PasswordCipher()
) {
    private val gson = Gson()

    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val API_TOKEN = stringPreferencesKey("api_token")
        val SESSION_TOKEN = stringPreferencesKey("session_token")
        val USER_JSON = stringPreferencesKey("user_json")
        val THEME_MODE = stringPreferencesKey("theme_mode")
        val REMEMBER = booleanPreferencesKey("remember_password")
        val SAVED_USERNAME = stringPreferencesKey("saved_username")
        val SAVED_PASSWORD = stringPreferencesKey("saved_password_enc")
        val LAST_USERNAME = stringPreferencesKey("last_username")
        val THUMB_WIDTH = intPreferencesKey("thumb_width")
        val PHOTO_QUALITY = intPreferencesKey("photo_quality")
        val LAST_SYNC_AT = stringPreferencesKey("last_sync_at")
    }

    /** 服务器连接配置 */
    data class Connection(
        val serverUrl: String = "",
        val apiToken: String = ""
    )

    val connection: Flow<Connection> = context.settingsDataStore.data
        .catch { if (it is IOException) emit(emptyPreferences()) else throw it }
        .map { p ->
            Connection(
                serverUrl = p[Keys.SERVER_URL].orEmpty(),
                apiToken = p[Keys.API_TOKEN].orEmpty()
            )
        }

    suspend fun connectionOnce(): Connection = connection.first()

    suspend fun saveConnection(serverUrl: String, apiToken: String) {
        context.settingsDataStore.edit { p ->
            p[Keys.SERVER_URL] = serverUrl.trim()
            p[Keys.API_TOKEN] = apiToken.trim()
        }
    }

    /** 登录态快照；未登录时 token 为空 */
    val session: Flow<SessionSnapshot> = context.settingsDataStore.data
        .catch { if (it is IOException) emit(emptyPreferences()) else throw it }
        .map { p ->
            val token = p[Keys.SESSION_TOKEN].orEmpty()
            val json = p[Keys.USER_JSON].orEmpty()
            val user = if (json.isBlank()) UserDto() else runCatching {
                gson.fromJson(json, UserDto::class.java)
            }.getOrDefault(UserDto())
            SessionSnapshot(token = token, user = user)
        }

    suspend fun sessionOnce(): SessionSnapshot = session.first()

    suspend fun saveSession(token: String, user: UserDto) {
        context.settingsDataStore.edit { p ->
            p[Keys.SESSION_TOKEN] = token
            p[Keys.USER_JSON] = gson.toJson(user)
        }
    }

    /**
     * 清除登录态。
     * 注意只清令牌与用户信息，服务器地址/连接码要保留——
     * 否则用户被顶下线后重新登录还要再填一遍连接码，现场很难拿到。
     */
    suspend fun clearSession() {
        context.settingsDataStore.edit { p ->
            p[Keys.SESSION_TOKEN] = ""
            p[Keys.USER_JSON] = ""
        }
    }

    /** 主题模式：light / dark / system */
    val themeMode: Flow<String> = context.settingsDataStore.data
        .catch { if (it is IOException) emit(emptyPreferences()) else throw it }
        .map { it[Keys.THEME_MODE] ?: "system" }

    suspend fun setThemeMode(mode: String) {
        context.settingsDataStore.edit { p -> p[Keys.THEME_MODE] = mode }
    }

    /** 记住密码开关 */
    val rememberPassword: Flow<Boolean> = context.settingsDataStore.data
        .catch { if (it is IOException) emit(emptyPreferences()) else throw it }
        .map { it[Keys.REMEMBER] ?: false }

    suspend fun setRememberPassword(value: Boolean) {
        context.settingsDataStore.edit { p ->
            p[Keys.REMEMBER] = value
            // 关闭「记住密码」时必须立刻抹掉已存密文，否则开关形同虚设
            if (!value) {
                p[Keys.SAVED_PASSWORD] = ""
            }
        }
    }

    /** 已保存的账号（明文）与密码（密文，取用时解密） */
    suspend fun savedCredential(): Pair<String, String> {
        val p = context.settingsDataStore.data.first()
        val username = p[Keys.SAVED_USERNAME].orEmpty()
        val enc = p[Keys.SAVED_PASSWORD].orEmpty()
        return username to if (enc.isBlank()) "" else cipher.decrypt(enc)
    }

    suspend fun saveCredential(username: String, password: String) {
        context.settingsDataStore.edit { p ->
            p[Keys.SAVED_USERNAME] = username
            p[Keys.LAST_USERNAME] = username
            p[Keys.SAVED_PASSWORD] = if (password.isBlank()) "" else cipher.encrypt(password)
        }
    }

    /** 最近一次登录的用户名（即使未勾选记住密码也保留，用于登录页自动填充） */
    val lastUsername: Flow<String> = context.settingsDataStore.data
        .catch { if (it is IOException) emit(emptyPreferences()) else throw it }
        .map { it[Keys.LAST_USERNAME].orEmpty() }

    suspend fun setLastUsername(username: String) {
        context.settingsDataStore.edit { p -> p[Keys.LAST_USERNAME] = username }
    }

    /** 网格缩略图请求宽度：弱网下可调小以省流量 */
    val thumbWidth: Flow<Int> = context.settingsDataStore.data
        .catch { if (it is IOException) emit(emptyPreferences()) else throw it }
        .map { it[Keys.THUMB_WIDTH] ?: 360 }

    suspend fun setThumbWidth(value: Int) {
        context.settingsDataStore.edit { p -> p[Keys.THUMB_WIDTH] = value }
    }

    /** 上传照片压缩质量 1-100 */
    val photoQuality: Flow<Int> = context.settingsDataStore.data
        .catch { if (it is IOException) emit(emptyPreferences()) else throw it }
        .map { it[Keys.PHOTO_QUALITY] ?: 82 }

    suspend fun setPhotoQuality(value: Int) {
        context.settingsDataStore.edit { p -> p[Keys.PHOTO_QUALITY] = value.coerceIn(30, 100) }
    }

    suspend fun markSynced() {
        context.settingsDataStore.edit { p ->
            p[Keys.LAST_SYNC_AT] = java.time.Instant.now().toString()
        }
    }

    val lastSyncAt: Flow<String> = context.settingsDataStore.data
        .catch { if (it is IOException) emit(emptyPreferences()) else throw it }
        .map { it[Keys.LAST_SYNC_AT].orEmpty() }
}
