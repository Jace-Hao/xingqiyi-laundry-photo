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
  exportPhotos: (token, payload) => call('records:exportPhotos', payload, token),
  exportPhotosByDate: (token, payload) => call('records:exportPhotosByDate', payload, token),

  // 用户管理（只传原始类型参数，对象在桥接层内组装）
  listUsers: (token) => call('users:list', undefined, token),
  createUser: (token, username, name, role, password, capture, query, store) =>
    call(
      'users:create',
      { username, name, role, password, permissions: { capture: !!capture, query: !!query }, store: store || '' },
      token
    ),
  updateUser: (token, id, name, role, active, capture, query, newPassword, store) => {
    const p = { id, name, role, active: !!active, newPassword: newPassword || undefined };
    if (capture !== undefined && capture !== null && query !== undefined && query !== null) {
      p.permissions = { capture: !!capture, query: !!query };
    }
    // store 传 null/undefined 表示本次不修改门店；传空字符串表示清空门店
    if (store !== undefined && store !== null) p.store = String(store);
    return call('users:update', p, token);
  },
  deleteUser: (token, id) => call('users:delete', { id }, token),

  // 日志与总览
  listLogs: (token, payload) => call('logs:list', payload, token),
  logActionOptions: (token) => call('logs:actionOptions', undefined, token),
  logFilterUsers: (token) => call('logs:filterUsers', undefined, token),
  overview: (token) => call('stats:overview', undefined, token),

  // 系统配置（本地，不随客户端转发）
  systemInfo: () => ipcRenderer.invoke('system:info'),
  // 四级角色清单与能力矩阵（本地静态元数据，渲染角色下拉用）
  roleOptions: () => ipcRenderer.invoke('system:roles'),
  // 内置操作手册（本地读取，不随客户端转发到服务器）
  manual: () => ipcRenderer.invoke('system:manual'),
  // 登录凭据保存（本地，绝不随客户端转发到服务器）：
  // 这里刻意用 ipcRenderer.invoke 直连本机，而不是 call()——
  // call() 在客户端模式会把参数发到远程服务端，那样密码就会离开本机。
  listCredentials: () => ipcRenderer.invoke('credentials:list'),
  getCredential: (username) => ipcRenderer.invoke('credentials:get', { username }),
  saveCredential: (payload) => ipcRenderer.invoke('credentials:save', payload),
  removeCredential: (username) => ipcRenderer.invoke('credentials:remove', { username }),
  clearCredentials: () => ipcRenderer.invoke('credentials:clear'),
  licenseStatus: () => ipcRenderer.invoke('license:status'),
  activate: (code) => ipcRenderer.invoke('license:activate', code),
  offlineStatus: () => ipcRenderer.invoke('offline:status'),
  syncOffline: () => ipcRenderer.invoke('offline:sync'),
  setMode: (mode) => ipcRenderer.invoke('system:setMode', mode),
  setClientConfig: (serverUrl, serverToken) =>
    ipcRenderer.invoke('system:setClientConfig', { serverUrl, serverToken }),
  testServer: (serverUrl, serverToken) =>
    ipcRenderer.invoke('system:testServer', { serverUrl, serverToken }),
  updateSettings: (token, port) => ipcRenderer.invoke('system:settings', { port }, token),
  resetApiToken: (token) => ipcRenderer.invoke('system:resetToken', undefined, token),
  setPhotoPath: (token, pathValue) => ipcRenderer.invoke('system:photoPath', { path: pathValue }, token),
  choosePhotoDir: () => ipcRenderer.invoke('system:choosePhotoDir'),
  chooseExportDir: () => ipcRenderer.invoke('system:chooseExportDir'),
  localIp: () => ipcRenderer.invoke('system:localIp'),
  version: () => ipcRenderer.invoke('system:version'),
  checkUpdate: () => ipcRenderer.invoke('system:checkUpdate'),
  downloadUpdate: (url, name) => ipcRenderer.invoke('system:downloadUpdate', { url, name }),
  cancelDownload: () => ipcRenderer.invoke('system:cancelDownload'),
  onDownloadProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('update:download-progress', fn);
    return () => ipcRenderer.removeListener('update:download-progress', fn);
  },
  openUpdateDir: () => ipcRenderer.invoke('system:openUpdateDir'),
  openUpdatePage: () => ipcRenderer.invoke('system:openUpdatePage'),
  copyText: (text) => ipcRenderer.invoke('system:copyText', text),
  // 开机自动启动（服务端模式可用，修改需系统管理员）
  autoLaunch: () => ipcRenderer.invoke('system:autoLaunch'),
  setAutoLaunch: (token, enabled) => ipcRenderer.invoke('system:setAutoLaunch', { enabled: !!enabled }, token),
  // 强制推送安装包（服务端设置 / 客户端查询）
  forceUpdate: () => ipcRenderer.invoke('system:forceUpdate'),
  setForceUpdate: (token, enabled, fileName) =>
    ipcRenderer.invoke('system:setForceUpdate', { enabled: !!enabled, fileName }, token),
  checkForceUpdate: () => ipcRenderer.invoke('system:checkForceUpdate'),
  openInstaller: (file) => ipcRenderer.invoke('system:openInstaller', { file }),
  runInstaller: (file) => ipcRenderer.invoke('system:runInstaller', { file }),
  onForceUpdate: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('update:force', fn);
    return () => ipcRenderer.removeListener('update:force', fn);
  }
});
