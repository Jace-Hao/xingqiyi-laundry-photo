package com.xingqiyi.laundryphoto.data.model

/**
 * 四级角色与能力矩阵。
 *
 * 与桌面端 main/store.js 的 ROLES 一一对应（单一数据源原则的另一侧）：
 * scopeAll=true 表示可见范围为全部门店，否则仅本门店。
 * 这里刻意不从服务端动态拉取——角色能力是固定的业务规则，
 * 硬编码在端上可以让界面在「无网络」时也能正确裁剪菜单，不会带着错误入口进入离线模式。
 */
enum class Role(
    val key: String,
    val label: String,
    /** 能否拍照录入 */
    val capture: Boolean,
    /** 能否查询订单 */
    val query: Boolean,
    /** 能否查看门店操作日志 */
    val viewStoreLogs: Boolean,
    /** 能否管理账号 */
    val manageUsers: Boolean,
    /** 能否修改系统设置 */
    val systemSettings: Boolean,
    /** 数据可见范围：true=全部门店，false=仅本门店 */
    val scopeAll: Boolean
) {
    SYSADMIN("sysadmin", "系统管理员", true, true, true, true, true, true),
    STORE_ADMIN("storeadmin", "门店管理员", false, true, true, false, false, false),
    CAPTURE("capture", "拍照账号", true, true, false, false, false, false),
    QUERY("query", "查询账号", false, true, false, false, false, false);

    companion object {
        /**
         * 角色值解析。
         * 未知角色一律按最小权限（查询账号）处理，而不是抛异常或放行——
         * 服务端未来新增角色时，老版本 App 不应因此崩溃或意外获得更高权限。
         */
        fun of(key: String?): Role =
            entries.firstOrNull { it.key == key } ?: QUERY
    }
}
