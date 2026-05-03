# Desktop 启动 server-agent 设计

## 背景

Desktop（Electron 主进程）在配置完成后需要启动 `server-agent`（NestJS 后端）。开发模式和打包后的生产模式行为不同。

## 设计目标

- **开发模式**：server-agent 由开发者手动在终端启动（`pnpm dev:server-agent`），desktop 只负责检测连接
- **打包模式**：server-agent 随 Electron 应用一起分发，desktop 自动启动管理子进程

## 启动流程

### 开发模式

```
用户终端: pnpm dev:server-agent  (手动启动)
                ↓
用户终端: pnpm dev:desktop       (手动启动)
                ↓
main.ts: startServerAgent()
  → app.isPackaged === false
  → 不发 fork，只轮询检测 localhost:3100
  → 10s 内连通 → 正常启动
  → 超时 → dialog.showMessageBox("请先启动 server-agent"，[重试] [退出])
```

### 打包模式

```
用户双击 Anybot.app
                ↓
main.ts: startServerAgent()
  → app.isPackaged === true
  → fork(process.resourcesPath + '/server-agent/main.js')
  → 轮询检测 localhost:3100（30s 超时）
  → 失败 → dialog.showErrorBox + app.quit()
  → 子进程崩溃 → 自动重启（最多 3 次）
```

## 改动文件

### 1. `apps/desktop/src/main.ts` — `startServerAgent()` 重构

核心逻辑拆分为三个函数：

```
startServerAgent()
  ├── connectToServerAgent()     // dev 模式：纯轮询连接，无 fork
  ├── forkServerAgent()          // prod 模式：fork + 健康检查
  └── pollForReady(timeout)      // 公有轮询逻辑（两种模式共用）
```

**伪代码：**

```typescript
function startServerAgent(): Promise<void> {
  if (app.isPackaged) {
    return forkServerAgent();
  }
  return connectToServerAgent();
}

async function connectToServerAgent(): Promise<void> {
  while (true) {
    try {
      await pollForReady(10000); // 10s 超时
      return;
    } catch {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: "server-agent 未启动",
        message: "请先在终端运行 pnpm dev:server-agent，然后点击重试",
        buttons: ["重试", "退出"],
      });
      if (response === 1) app.quit();
    }
  }
}

async function forkServerAgent(): Promise<void> {
  const serverAgentPath = path.join(
    process.resourcesPath, "server-agent", "main.js"
  );
  let restartCount = 0;

  return new Promise((resolve, reject) => {
    const doFork = () => {
      serverProcess = fork(serverAgentPath, [], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: { ...process.env, ANYBOT_DIR: getAnybotDir() },
      });

      serverProcess.on("exit", (code) => {
        if (code !== 0 && restartCount < 3) {
          restartCount++;
          setTimeout(doFork, 2000);
        } else {
          reject(new Error(`server-agent 已退出 (code ${code})`));
        }
      });

      serverProcess.on("error", reject);
    };

    doFork();
    // pollForReady(30000) then resolve()
  });
}
```

### 2. `apps/desktop/electron-builder.yml` — 打包配置

```yaml
extraResources:
  - from: ../server-agent/dist/
    to: server-agent/
    filter:
      - "**/*"
```

### 3. `apps/server-agent/package.json` — 确认 build 脚本

```json
{
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch",
    "start": "node dist/main"
  }
}
```

### 4. `apps/desktop/src/main.ts` — `before-quit` 优雅关闭

```typescript
app.on("before-quit", () => {
  if (serverProcess) {
    // 先发 IPC 消息通知优雅关闭
    serverProcess.send("shutdown");
    // 3 秒后强制 kill
    setTimeout(() => {
      if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
      }
    }, 3000);
  }
});
```

## 错误处理

| 场景 | 模式 | 行为 |
|------|------|------|
| server-agent 未启动 | dev | `showMessageBox`：提示手动启动 + [重试/退出] |
| server-agent fork 失败 | prod | `showErrorBox` 显示错误 + `app.quit()` |
| server-agent 崩溃 | prod | 自动重启（最多 3 次，间隔 2s），超过 3 次 `showErrorBox` + `app.quit()` |
| app 退出 | prod | `shutdown` IPC 消息 → 3s 等待 → `kill()` |
| app 退出 | dev | 无需操作（进程非 desktop 管理） |

## 未覆盖

- web-agent 的 dev/prod 分发方式（后续单独设计）
- server-agent 的 IPC 消息处理（目前 server-agent 未监听 message 事件）
