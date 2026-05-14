---
name: desktop
description: "Electron 桌面应用开发规范 Use when files matching apps/desktop/** change, or when explicitly invoked."
---

# Electron 桌面应用规范

## 架构

- Main Process：窗口管理、系统托盘、NestJS 进程生命周期管理
- Preload Script：安全的 IPC 桥接，使用 contextBridge 暴露 API
- Renderer Process：加载 Next.js 静态产物，禁用 nodeIntegration

## 安全

- 始终禁用 `nodeIntegration`，启用 `contextIsolation`
- 通过 `preload.ts` + `contextBridge` 暴露有限的 API
- 使用 IPC 通信（ipcMain / ipcRenderer）而非直接访问 Node API

## NestJS 集成

- Main Process 通过 `child_process.fork()` 启动 NestJS server
- 等待 NestJS 就绪后再创建 BrowserWindow
- 应用退出时优雅关闭 NestJS 进程

## 进程通信

```typescript
// preload.ts - 暴露安全 API
contextBridge.exposeInMainWorld('electronAPI', {
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  onServerReady: (callback: () => void) => ipcRenderer.on('server-ready', callback),
})
```

