// preload 桥：只暴露最小 API，不暴露 Node / 文件系统 / 执行接口（方案 §4.1）。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aipeople", {
  isDesktop: true,
  /** 询问内嵌后台端口（独立模式等待启动完成；开发模式返回外部端口）。 */
  getBackendPort: () => ipcRenderer.invoke("backend:port"),
  /** 订阅后台启动失败事件（独立模式）。 */
  onBackendFailed: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("backend:failed", listener);
    return () => ipcRenderer.removeListener("backend:failed", listener);
  },
  appInfo: () => ipcRenderer.invoke('app:info'),
  openData: () => ipcRenderer.invoke('app:openData'),
  copyText: (text) => ipcRenderer.invoke('app:copyText', text),
  openExternal: (url) => ipcRenderer.invoke('app:external', url),
  tools: {
    snapshot: () => ipcRenderer.invoke('tools:snapshot'),
    install: (id) => ipcRenderer.invoke('tools:install', id),
    save: (input) => ipcRenderer.invoke('tools:save', input),
    remove: (id) => ipcRenderer.invoke('tools:remove', id),
    choose: () => ipcRenderer.invoke('tools:choose'),
    chooseImage: () => ipcRenderer.invoke('tools:chooseImage'),
    enqueue: (input) => ipcRenderer.invoke('tools:enqueue', input),
    cancel: (id) => ipcRenderer.invoke('tools:cancel', id),
    export: () => ipcRenderer.invoke('tools:export'),
    saveAccount: (input) => ipcRenderer.invoke('accounts:save', input),
    removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
    pauseAccount: (id) => ipcRenderer.invoke('accounts:pause', id),
  },
  live: {
    get: () => ipcRenderer.invoke('live:get'),
    save: (input) => ipcRenderer.invoke('live:save', input),
    chooseVideo: () => ipcRenderer.invoke('live:chooseVideo'),
    voices: () => ipcRenderer.invoke('live:voices'),
    synthesize: (input) => ipcRenderer.invoke('live:synthesize', input),
    open: () => ipcRenderer.invoke('live:open'),
    command: (action) => ipcRenderer.invoke('live:command', action),
    onState: (callback) => { const listener = (_event, data) => callback(data); ipcRenderer.on('live:state',listener); return () => ipcRenderer.removeListener('live:state',listener); },
  },
});
