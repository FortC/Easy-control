// preload 桥：只暴露最小 API，不暴露 Node / 文件系统 / 执行接口（方案 §4.1）。
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("aipeople", {
  isDesktop: true,
  version: "0.1.0",
  // 后端地址由渲染进程本地配置管理（开发默认本机）
});
