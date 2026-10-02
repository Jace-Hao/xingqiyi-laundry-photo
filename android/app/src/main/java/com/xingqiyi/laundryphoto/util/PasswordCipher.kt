package com.xingqiyi.laundryphoto.util

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 「记住密码」的加密存储。
 *
 * 为什么不能直接存明文：桌面端把密码交给 Electron safeStorage（Windows DPAPI / macOS Keychain），
 * 移动端没有等价的现成封装，直接写 DataStore 等于把店员密码以明文留在设备上，
 * root 或备份导出即可取走。因此用 AndroidKeyStore 生成一把不可导出的 AES-GCM 密钥，
 * 只把密文落盘——密钥本身由系统安全硬件保管，应用拿不到私钥材料。
 *
 * 失败一律降级为「不记住密码」而不是崩溃：少数机型/定制 ROM 的 Keystore 不可用，
 * 此时宁可让用户每次手输，也不能因为加密失败导致登录功能不可用。
 */
class PasswordCipher {

    companion object {
        private const val ALIAS = "xqy_credential_aes"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
    }

    /** @return Base64(IV || 密文)；不可用时返回空串，调用方据此放弃记住密码 */
    fun encrypt(plain: String): String = runCatching {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val iv = cipher.iv
        val body = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        Base64.getEncoder().encodeToString(iv + body)
    }.getOrDefault("")

    /** @return 明文；密文损坏或密钥不可用时返回空串 */
    fun decrypt(payload: String): String {
        if (payload.isBlank()) return ""
        return runCatching {
            val raw = Base64.getDecoder().decode(payload)
            if (raw.size <= IV_BYTES) return ""
            val iv = raw.copyOfRange(0, IV_BYTES)
            val body = raw.copyOfRange(IV_BYTES, raw.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(body), Charsets.UTF_8)
        }.getOrDefault("")
    }

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = ks.getKey(ALIAS, null) as? SecretKey
        if (existing != null) return existing

        val spec = KeyGenParameterSpec.Builder(
            ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            // 不需要用户鉴权：记住密码的意义就是免输入，要求每次 biometric 反而更麻烦；
            // 风险由「密钥不可导出 + 仅本应用可用」承担。
            .setUserAuthenticationRequired(false)
            .setRandomizedEncryptionRequired(true)
            .build()

        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).run {
            init(spec)
            generateKey()
        }
    }
}
