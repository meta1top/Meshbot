# Desktop 启动 server-agent 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 `startServerAgent()`，用 `app.isPackaged` 区分开发/打包模式启动 server-agent

**Architecture:** 提取公共 `pollForReady()` 轮询逻辑，dev 模式调用 `connectToServerAgent()`（纯连接检测+重试），prod 模式调用 `forkServerAgent()`（fork 子进程+崩溃重启）。修改 `electron-builder.yml` 将 server-agent dist 打包为 extraResource。

**Tech Stack:** Electron, TypeScript, Node.js child_process, electron-builder

---

### Task 1: 提取 `pollForReady(timeout)` 公共轮询函数

**Files:**
- Modify: `apps/desktop/src/main.ts:39-95`

- [ ] **Step 1: 将现有轮询逻辑提取为独立函数**

替换第 79-93 行的内联 poll 逻辑为独立的 `pollForReady` 函数，同时保留原有的 fork 逻辑不动（后续 task 再改）：

```typescript
function pollForReady(timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const endTime = Date.now() + timeoutMs;

    const poll = () => {
      if (Date.now() >= endTime) {
        reject(new Error(`server-agent start timeout (${timeoutMs / 1000}s)`));
        return;
      }

      const req = http.get("http://localhost:3100", (res: http.IncomingMessage) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        setTimeout(poll, 500);
      });
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(poll, 500);
      });
    };
    setTimeout(poll, 1000);
  });
}
```

- [ ] **Step 2: 修改 `startServerAgent()` 调用新函数**

将 `startServerAgent` 中的内联 poll + timeout 替换为：

```typescript
function startServerAgent(): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverAgentPath = path.join(
      __dirname,
      "..",
      "..",
      "server-agent",
      "dist",
      "main.js",
    );

    serverProcess = fork(serverAgentPath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        ANYBOT_DIR: getAnybotDir(),
      },
    });

    let stderr = "";
    serverProcess.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      reject(new Error(`server-agent start timeout (30s)\n${stderr}`));
    }, 30000);

    serverProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    serverProcess.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && code !== null) {
        reject(new Error(`server-agent exited with code ${code}\n${stderr}`));
      }
    });

    pollForReady(30000).then(() => {
      clearTimeout(timeout);
      resolve();
    }).catch((err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
```

- [ ] **Step 3: 验证编译通过**

```bash
cd /Users/grant/Meta1/anybot/apps/desktop && npx tsc --project tsconfig.json --noEmit
```

Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "refactor(desktop): extract pollForReady helper from startServerAgent"
```

---

### Task 2: 添加 `connectToServerAgent()` — 开发模式连接逻辑

**Files:**
- Modify: `apps/desktop/src/main.ts` — 在 `startServerAgent()` 之后插入新函数

- [ ] **Step 1: 添加 `connectToServerAgent` 函数**

在 `startServerAgent()` 函数之后、`app.whenReady()` 之前插入：

```typescript
async function connectToServerAgent(): Promise<void> {
  while (true) {
    try {
      await pollForReady(10000);
      return;
    } catch {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: "server-agent 未启动",
        message:
          "开发模式下需要手动启动 server-agent。\n\n请在终端运行：pnpm dev:server-agent\n然后点击「重试」。",
        buttons: ["重试", "退出"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 1) {
        app.quit();
      }
    }
  }
}
```

- [ ] **Step 2: 验证编译通过**

```bash
cd /Users/grant/Meta1/anybot/apps/desktop && npx tsc --project tsconfig.json --noEmit
```

Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "feat(desktop): add connectToServerAgent for dev mode"
```

---

### Task 3: 重构为 `forkServerAgent()` — 打包模式 + 崩溃重启

**Files:**
- Modify: `apps/desktop/src/main.ts` — 替换 `startServerAgent()` 为 `forkServerAgent()`

- [ ] **Step 1: 将 `startServerAgent` 重写为 `forkServerAgent`**

删除旧的 `startServerAgent()` 函数（第 39-94 行），替换为：

```typescript
async function forkServerAgent(): Promise<void> {
  const serverAgentPath = path.join(process.resourcesPath, "server-agent", "main.js");
  let restartCount = 0;

  return new Promise((resolve, reject) => {
    const doFork = () => {
      serverProcess = fork(serverAgentPath, [], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: {
          ...process.env,
          ANYBOT_DIR: getAnybotDir(),
        },
      });

      let stderr = "";

      serverProcess.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      serverProcess.on("error", (err) => {
        reject(new Error(`server-agent fork failed: ${err.message}`));
      });

      serverProcess.on("exit", (code) => {
        if (code !== 0 && code !== null && restartCount < 3) {
          restartCount++;
          stderr = "";
          setTimeout(doFork, 2000);
        } else if (code !== 0 && code !== null) {
          reject(
            new Error(
              `server-agent exited with code ${code} after ${restartCount + 1} attempts\n${stderr}`,
            ),
          );
        }
      });

      pollForReady(30000)
        .then(resolve)
        .catch((err) => {
          if (serverProcess) {
            serverProcess.kill();
            serverProcess = null;
          }
          reject(new Error(`server-agent start timeout (30s)\n${stderr}`));
        });
    };

    doFork();
  });
}
```

- [ ] **Step 2: 添加 `startServerAgent` 调度函数**

```typescript
function startServerAgent(): Promise<void> {
  if (app.isPackaged) {
    return forkServerAgent();
  }
  return connectToServerAgent();
}
```

- [ ] **Step 3: 验证编译通过**

```bash
cd /Users/grant/Meta1/anybot/apps/desktop && npx tsc --project tsconfig.json --noEmit
```

Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "feat(desktop): forkServerAgent with crash restart for prod mode"
```

---

### Task 4: 更新 `before-quit` — 优雅关闭

**Files:**
- Modify: `apps/desktop/src/main.ts:146-151`

- [ ] **Step 1: 替换 before-quit 处理器**

```typescript
app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.send("shutdown");
    setTimeout(() => {
      if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
      }
    }, 3000);
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "feat(desktop): graceful shutdown with IPC message before kill"
```

---

### Task 5: 更新 `electron-builder.yml` — 打包 server-agent

**Files:**
- Modify: `apps/desktop/electron-builder.yml`

- [ ] **Step 1: 添加 extraResources 配置**

```yaml
appId: com.anybot.desktop
productName: Anybot
directories:
  output: release
files:
  - dist/**/*
extraResources:
  - from: ../server-agent/dist/
    to: server-agent/
    filter:
      - "**/*"
mac:
  target:
    - dmg
    - zip
win:
  target:
    - nsis
linux:
  target:
    - AppImage
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/electron-builder.yml
git commit -m "config(desktop): bundle server-agent dist as extraResources"
```

---

### Task 6: 更新 `app.whenReady` — dev 模式错误处理优化

**Files:**
- Modify: `apps/desktop/src/main.ts` — `app.whenReady` 的 catch 块

- [ ] **Step 1: 优化 dev 模式下的启动失败处理**

在 `app.whenReady().then(async () => {` 中将 `if (!needsSetup)` 块改为：

```typescript
if (!needsSetup) {
  try {
    await startServerAgent();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (app.isPackaged) {
      dialog.showErrorBox(
        "Server Agent 启动失败",
        `无法启动 server-agent：${message}\n\n请检查日志：${getLogDir()}`,
      );
      app.quit();
    }
    // Dev mode: connectToServerAgent already handles retry/quit internally
  }
}
```

- [ ] **Step 2: 验证编译通过**

```bash
cd /Users/grant/Meta1/anybot/apps/desktop && npx tsc --project tsconfig.json --noEmit
```

Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "fix(desktop): dev mode startup failure shows retry dialog, prod mode exits"
```

---

### Task 7: 端到端验证

- [ ] **Step 1: 验证 dev 模式编译和类型检查**

```bash
cd /Users/grant/Meta1/anybot/apps/desktop && npx tsc --project tsconfig.json
```

Expected: 编译成功，生成 `dist/main.js` 等文件

- [ ] **Step 2: 验证 server-agent 编译**

```bash
cd /Users/grant/Meta1/anybot/apps/server-agent && pnpm build
```

Expected: NestJS 编译成功，生成 `dist/main.js`

- [ ] **Step 3: 验证 git 状态干净**

```bash
cd /Users/grant/Meta1/anybot && git status
```

Expected: 无未提交的更改
