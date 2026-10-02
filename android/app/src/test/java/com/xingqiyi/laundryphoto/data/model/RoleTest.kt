package com.xingqiyi.laundryphoto.data.model

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * 角色矩阵是端上裁剪菜单的单一依据（硬编码而非服务端下发的意义在于离线时也能正确裁剪）。
 * 这里重点验证：未知角色必须降级为最小权限（查询账号），不能放行也不能崩溃。
 */
class RoleTest {

    @Test
    fun of_parsesKnownKeys() {
        assertThat(Role.of("sysadmin")).isEqualTo(Role.SYSADMIN)
        assertThat(Role.of("storeadmin")).isEqualTo(Role.STORE_ADMIN)
        assertThat(Role.of("capture")).isEqualTo(Role.CAPTURE)
        assertThat(Role.of("query")).isEqualTo(Role.QUERY)
    }

    @Test
    fun of_fallsBackToQueryForUnknown() {
        assertThat(Role.of("")).isEqualTo(Role.QUERY)
        assertThat(Role.of(null)).isEqualTo(Role.QUERY)
        assertThat(Role.of("superuser")).isEqualTo(Role.QUERY)
    }

    @Test
    fun permissionMatrix() {
        assertThat(Role.SYSADMIN.capture).isTrue()
        assertThat(Role.SYSADMIN.manageUsers).isTrue()
        assertThat(Role.SYSADMIN.scopeAll).isTrue()

        assertThat(Role.STORE_ADMIN.capture).isFalse()
        assertThat(Role.STORE_ADMIN.viewStoreLogs).isTrue()
        assertThat(Role.STORE_ADMIN.scopeAll).isFalse()

        assertThat(Role.CAPTURE.capture).isTrue()
        assertThat(Role.CAPTURE.manageUsers).isFalse()

        assertThat(Role.QUERY.capture).isFalse()
        assertThat(Role.QUERY.query).isTrue()
    }
}
