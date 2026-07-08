# CLI Agent 设计文档

## 背景与目标

当前 MeshBot 的桌面端（Electron）通过 `fork()` 内嵌启动 `server-agent`，三者（desktop + web-agent + server-agent）打包为一个安装包。这导致：

- Agent 无法在无 GUI 的服务器上独立运行
- 桌面端和 Agent 必须同步更新
- 无法远程管理 Agent

**目标**：将 App（桌面壳）和 Agent（server-agent）解耦，Agent 作为独立的跨平台 CLI 工具发布，可以：

1. 在无 GUI 环境中独立运行
2. 自带 Web UI（浏览器直接访问）
3. 支持系统服务注册（开机自启）
4. 桌面 App 作为远程客户端连接
5. 内置完整用户认证

---

## 架构设计

### 新旧架构对比

**当前（紧耦合）**：

```
Electron Desktop
  ├── fork() ──→ server-agent (NestJS)
  └── app:// ──→ web-agent (静态文件)
```

**目标（解耦分离）**：

```
meshbot (CLI)           server-agent (NestJS)
  ├── start ──fork──→  ├── API (Agent 业务)
  ├── stop            ├── 静态文件服务 (web-agent)
  ├── status          ├── 本地用户认证
  └── service         ├── SQLite / LanceDB
      install/
      uninstall

桌面 App / 浏览器 ──HTTP──→ server-agent
```

### 组件职责

| 组件 | 职责 | 部署方式 |
|------|------|----------|
| `apps/cli-agent` | 进程管理、系统服务注册、配置文件管理 | `npm install -g @meshbot/agent` |
| `apps/server-agent` | NestJS HTTP 服务：Agent 业务 API、静态 UI 托管、本地用户认证 | `cli-agent` 启动的子进程 |
| `apps/web-agent` | Next.js 前端，构建为静态文件 | 构建产物被 `server-agent` 内嵌托管 |
| `apps/desktop` | 远程客户端壳：保存 Agent 连接地址、加载远程 UI | 独立的 Electron 安装包 |

---

## 组件设计

### `apps/cli-agent` —— CLI 进程管理器

**技术栈**：Node.js + `commander` + `chalk`

**命令**：

| 命令 | 行为 |
|------|------|
| `meshbot start [--port] [--data-dir] [--daemon]` | 检查运行状态 → spawn server-agent → 写入 PID → health check |
| `meshbot stop` | 读取 PID → SIGTERM → 等待退出 → 清理 PID |
| `meshbot status` | 检查 PID → 显示进程状态、内存、端口、运行时长 |
| `meshbot service install [--user]` | 按平台生成并注册系统服务文件 |
| `meshbot service uninstall` | 移除系统服务文件 |
| `meshbot config set <key> <value>` | 修改配置文件 |
| `meshbot config get <key>` | 读取配置项 |

**进程守护**：

- `start` 默认前台运行，`--daemon` 后台运行
- 子进程异常退出且退出码非 0，自动重试最多 3 次
- 标准输出/错误重定向到 `~/.meshbot/logs/agent.log`

**跨平台服务注册**：

- **macOS**：`~/Library/LaunchAgents/com.meshbot.agent.plist`
- **Linux**：`~/.config/systemd/user/meshbot-agent.service`（用户级服务，无需 root）
- **Windows**：`node-windows` 库生成 Windows Service

**配置文件**（`~/.meshbot/cli-config.json`）：

```json
{
  "port": 3100,
  "dataDir": "~/.meshbot",
  "serverAgentPath": null,
  "logLevel": "info",
  "autoStart": false
}
```

**路径解析优先级**：

1. 配置文件中显式指定的 `serverAgentPath`
2. 与 CLI 可执行文件相邻的 `./server-agent` 目录
3. `require.resolve('@meshbot/server-agent/package.json')`

### `apps/server-agent` —— 改造后的 NestJS 服务

**新增模块**：

#### 1. ServeStaticModule

- 生产模式：挂载 `web-agent` 构建产物（`out/` 目录），`/` 返回 `index.html`
- 开发模式：CORS 代理到 `localhost:3001`
- 现有 API 路由不变（`/api/*`）

#### 2. LocalAuthModule

- `POST /api/auth/setup-status` — 检查是否已有用户
- `POST /api/auth/register` — 首次初始化时开放，创建管理员账户后关闭
- `POST /api/auth/login` — 返回 JWT
- 密码使用 `bcrypt` 哈希，JWT 使用环境密钥签名
- 用户数据存 SQLite（复用现有数据库）

#### 3. CORS 调整

- 开放 `origin: true`（允许任意来源）
- 所有 API 端点（除 `/api/auth/*` 和 `/api/setup-status`）需要 `Authorization: Bearer <token>`

### `apps/desktop` —— 改造为远程客户端

**移除**：

- `forkServerAgent()`、`startServerAgent()`、`connectToServerAgent()`
- `extraResources` 中的 `server-agent`
- 自定义协议 `app://`（不再内嵌静态文件）

**新增**：

- 连接配置界面：首次启动时要求输入 Agent URL 和登录凭据
- 配置持久化到 `localStorage` + Electron `safeStorage` 加密 token
- 加载远程 URL（`win.loadURL(agentUrl)`），不再区分打包/开发模式
- 保留系统托盘、IPC 处理器（窗口控制、文件选择）

### `apps/web-agent` —— 构建产物托管

**代码逻辑不变**。

**构建调整**：

- `pnpm build` 后，`out/` 目录需要被复制到 `server-agent` 的资源路径
- 开发时 `server-agent` 代理到 `localhost:3001`

---

## 数据流

### 1. Agent 启动流程（`meshbot start`）

```
用户: meshbot start

cli-agent
  ├── 读取 ~/.meshbot/cli-config.json
  ├── 检查 PID 文件是否存在
  │     └── 存在 → 检查进程是否存活
  │           ├── 存活 → 输出 "Agent already running on port 3100"
  │           └── 已死 → 清理旧 PID 文件，继续
  ├── 解析 server-agent 路径（配置 / 相邻目录 / npm resolve）
  ├── spawn('node', [serverAgentPath], { env: { MESHBOT_PORT, MESHBOT_DATA_DIR } })
  ├── 写入 PID 文件
  ├── 等待 health check（GET /api/setup-status）
  │     └── 超时 30s → 输出日志，exit 1
  └── 输出 "Agent started on http://0.0.0.0:3100"
      └── --daemon ? detach 并退出 : 保持前台
```

### 2. 首次配置流程（浏览器访问）

```
浏览器 → http://localhost:3100/
           │
           └── server-agent ServeStaticModule
                 └── 返回 web-agent 的 index.html
                       │
                       └── web-agent 前端加载
                             ├── 调用 GET /api/auth/setup-status
                             │     └── 无用户 → 显示"初始化向导"
                             │     └── 有用户 → 显示登录页
                             │
                             └── 初始化向导
                                   ├── POST /api/auth/register
                                   │     └── 创建第一个管理员账户
                                   │     └── 返回 JWT
                                   └── 跳转到主界面
```

### 3. 桌面 App 连接流程

```
首次启动 desktop
  ├── 无保存的配置 → 显示"连接设置"窗口
  │     ├── 输入 Agent URL (http://localhost:3100)
  │     ├── 输入用户名/密码
  │     └── POST /api/auth/login → 获得 JWT
  │           └── 加密存储到 Electron safeStorage
  │
  └── win.loadURL(agentUrl)
        └── 加载远程 web-agent UI
              └── 前端自动附加 Authorization: Bearer <token>
                    └── server-agent AuthGuard 验证 JWT
```

### 4. 开发模式工作流

开发模式下 CLI 不用参与：

```bash
终端1: pnpm dev:server-agent   # 端口 3100
终端2: pnpm dev:web-agent      # 端口 3001
终端3: pnpm dev:desktop        # 连接 localhost:3100
```

`server-agent` 开发模式下通过代理把前端请求转发到 `localhost:3001`。

---

## 错误处理

### CLI 层

| 场景 | 处理 |
|------|------|
| PID 文件存在但进程已死 | 自动清理，视为未运行 |
| `start` 时端口被占用 | 检查是否有其他 meshbot 实例 → 提示"Agent already running" / 提示端口冲突 |
| `stop` 时无 PID 文件 | 输出 "Agent is not running"，exit 0 |
| `stop` 时 SIGTERM 超时 | 5 秒后发送 SIGKILL，然后清理 PID 文件 |
| server-agent 启动超时 | 30s health check 失败 → 输出 agent stdout/stderr 日志 → exit 1 |
| server-agent 崩溃重启 | 3 次重试后放弃，输出最后错误日志，保持停止 |

### server-agent 层

| 场景 | 处理 |
|------|------|
| 端口被占用 | 启动失败，NestFactory 抛出异常，CLI 捕获并显示 |
| 首次启动无用户 | `/api/auth/setup-status` 返回 `{ initialized: false }`，前端引导注册 |
| JWT 过期/无效 | 返回 401，前端跳转登录页 |
| 静态文件缺失 | 404，不影响 API |

### 桌面 App 层

| 场景 | 处理 |
|------|------|
| 连接失败 | 显示重试对话框，可修改 Agent URL |
| 认证失败 | 清除本地 token，跳转登录页 |
| Agent 离线 | 托盘图标变灰，定期重连 |

---

## 测试策略

| 层级 | 范围 | 工具 |
|------|------|------|
| 单元 | cli-agent 工具函数（config、pid-file、path-resolver） | vitest |
| 集成 | cli-agent start/stop/status + mock server | vitest + 临时目录 |
| E2E | 完整 cli-agent + server-agent + web-agent 链路 | CI + curl |
| 跨平台 | service install/uninstall | GitHub Actions (macOS/Linux/Windows) |

### CLI 集成测试示例

```typescript
// 使用 mock server-agent（Express）测试完整生命周期
test('start -> health check -> stop', async () => {
  const mockAgent = path.join(tmpDir, 'mock-server.js');
  writeFileSync(mockAgent, 'require("http").createServer(...).listen(3100)');

  setConfig({ serverAgentPath: mockAgent });

  await runCommand('start');
  expect(await fetch('http://localhost:3100')).toBeOk();

  await runCommand('stop');
  await expect(fetch('http://localhost:3100')).rejects.toThrow();
});
```

---

## 发布策略

### npm 包配置

**`apps/server-agent/package.json`**：

```json
{
  "name": "@meshbot/server-agent",
  "version": "0.0.1",
  "main": "dist/main.js",
  "files": ["dist"]
}
```

**`apps/cli-agent/package.json`**：

```json
{
  "name": "@meshbot/agent",
  "version": "0.0.1",
  "bin": { "meshbot": "./dist/cli.js" },
  "files": ["dist"],
  "dependencies": {
    "@meshbot/server-agent": "workspace:*"
  }
}
```

### 发布流程

1. 先发布 `@meshbot/server-agent`
2. 再发布 `@meshbot/agent`（`workspace:*` 会被 pnpm 自动替换为实际版本号）

```bash
pnpm --filter @meshbot/server-agent publish --access public
pnpm --filter @meshbot/agent publish --access public
```

### 用户安装

```bash
npm install -g @meshbot/agent

# npm 自动：
# 1. 下载 cli-agent
# 2. 下载 server-agent（作为依赖）
# 3. 下载 better-sqlite3 等原生模块（postinstall 下载预编译二进制）
# 4. 链接 meshbot 到全局 PATH

meshbot --version
meshbot start
```

### CI 自动发布

新增 `.github/workflows/publish-cli.yml`，支持手动触发版本 bump 并自动发布到 npm。

---

## 命令参考

```
meshbot <command> [options]

Commands:
  start [options]     启动 Agent 服务
    --port <number>   指定端口 (默认: 3100)
    --data-dir <path> 指定数据目录 (默认: ~/.meshbot)
    --daemon          后台运行

  stop                停止 Agent 服务
  status              查看 Agent 运行状态

  service install     注册为系统服务
    --user            用户级服务（无需 root）
  service uninstall   卸载系统服务

  config set <k> <v>  设置配置项
  config get <k>      读取配置项

Options:
  -h, --help          显示帮助
  -V, --version       显示版本号
```
