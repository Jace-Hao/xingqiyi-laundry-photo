package com.xingqiyi.laundryphoto.data.remote

/**
 * 接口错误分类。
 *
 * 分类的目的不是好看，而是让界面能给出**不同**的处理：
 * - [SessionRevoked]：唯一登录被顶下线 → 强制退回登录页并说明原因（不能当成普通失败提示，
 *   否则店员会以为密码过期而反复重试，这正是桌面端 v1.1.0 修掉的那个坑）；
 * - [Auth]：连接码失效 → 回到服务器配置页；
 * - [Network]：失联 → 进入离线模式，允许继续拍照并暂存；
 * - [Unsupported]：老服务端没有该接口 → 静默降级到兼容实现，不弹错误；
 * - [Business]：业务规则拒绝（无权限、参数非法等）→ 直接展示服务端文案。
 */
sealed class ApiError(message: String, cause: Throwable? = null) : Exception(message, cause) {
    /** 网络层不可达：可进入离线模式 */
    class Network(message: String, cause: Throwable? = null) : ApiError(message, cause)

    /** 连接码无效/过期：需要重新配置服务器 */
    class Auth(message: String) : ApiError(message)

    /** 业务规则拒绝：文案来自服务端，原样展示 */
    class Business(message: String) : ApiError(message)

    /** 会话被顶下线：必须强制退回登录页 */
    class SessionRevoked(message: String) : ApiError(message)

    /** 服务端不支持该接口（返回「接口不存在」）：走兼容降级分支 */
    class Unsupported(message: String) : ApiError(message)
}
