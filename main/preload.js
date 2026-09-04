'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 安全桥接：渲染进程只能通过 window.api 访问主进程能力，不暴露 ipcRenderer 本体。
 * 新架构下所有业务接口的第一个参数都是会话令牌（sessionToken），
 * 其余参数统一为原始类型/纯数据对象（在桥接层内组装），避免响应式对象跨进程。
 */
function plain(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v));
}

function call(channel, payload, sessionToken) {
  return ipcRenderer.invoke(channel, plain(payload), sessionToken || '');
}

contextBridge.exposeInMainWorld('api', {
  // 认证（登录无需令牌）
  login: (username, password) => call('auth:login', { username, password }),
  logout: (token) => call('auth:logout', undefined, token),
  currentUser: (token) => call('auth:current', undefined, token),
  changePassword: (token, oldPassword, newPassword) =>
    call('auth:changePassword', { oldPassword, newPassword }, token),

  // 衣物存档
  addRecord: (token, payload) => call('records:add', payload, token),
  listRecords: (token, payload) => call('records:list', payload, token),
  getRecord: (token, id) => call('records:get', { id }, token),
  deleteRecord: (token, id) => call('records:delete', { id }, token),
  deleteRecords: (token, ids) => call('records:deleteBatch', { ids }, token),

  // 用户管理（只传原始类型参数，对象在桥接层内组装）
  listUsers: (token) => call('users:list', undefined, token),
  createUser: (token, username, name, role, password, capture, query) =>
    call(
      'users:create',
      { username, name, role, password, permissions: { capture: !!capture, query: !!query } },
      token
    ),
  updateUser: (token, id, name, role, active, capture, query, newPassword) => {
    const p = { id, name, role, active: !!active, newPassword: newPassword || undefined };
    if (capture !== undefined && capture !== null && query !== undefined && query !== null) {
      p.permissions = { capture: !!capture, query: !!query };
    }
    return call('users:update', p, token);
  },
  deleteUser: (token, id) => call('users:delete', { id }, token),

  // 日志与总览
  listLogs: (token, payload) => call('logs:list', payload, token),
  overview: (token) => call('stats:overview', undefined, token),

  // 系统配置（本地，不随客户端转发）
  systemInfo: () => ipcRenderer.invoke('system:info'),
  setMode: (mode) => ipcRenderer.invoke('system:setMode', mode),
  setClientConfig: (serverUrl, serverToken) =>
    ipcRenderer.invoke('system:setClientConfig', { serverUrl, serverToken }),
  testServer: (serverUrl, serverToken) =>
    ipcRenderer.invoke('system:testServer', { serverUrl, serverToken }),
  updateSettings: (token, port) => ipcRenderer.invoke('system:settings', { port }, token),
  resetApiToken: (token) => ipcRenderer.invoke('system:resetToken', undefined, token),
  setPhotoPath: (token, pathValue) => ipcRenderer.invoke('system:photoPath', { path: pathValue }, token),
  choosePhotoDir: () => ipcRenderer.invoke('system:choosePhotoDir'),
  localIp: () => ipcRenderer.invoke('system:localIp'),
  version: () => ipcRenderer.invoke('system:version'),
  checkUpdate: () => ipcRenderer.invoke('system:checkUpdate'),
  openUpdateDir: () => ipcRenderer.invoke('system:openUpdateDir'),
  openUpdatePage: () => ipcRenderer.invoke('system:openUpdatePage'),
  copyText: (text) => ipcRenderer.invoke('system:copyText', text)
});
