# 发布配置（端口自检 + 同源伺服 + 多环境 server-main）设计

**日期：** 2026-07-01
**状态：** 已定稿（对应实施计划 `docs/superpowers/plans/2026-07-01-release-port-and-server-main-config.md`）

## 1. 背景与问题

meshbot 是本地优先 + 云端协同的双形态 Agent 平台。当前发布配置有三处硬编码，阻碍打包发布：

1. **server-agent 端口写死 3100**：`main.ts` 读 `MESHBOT_PORT ?? 3100`，桌面端 fork 时锁死 3100，CLI 默认 3100。多实例 / 端口被占即冲突。
2. **静态前端硬编码后端端口**：`packages/web-common/src/api/client.ts` 的 `resolveBaseURL()` 拼 `${hostname}:3100`。web-agent 是 `next export` 纯静态产物，端口一旦变化无法适应。
3. **server-main 地址打包后仍指本地**：server-agent 读 `MESHBOT_CLOUD_URL`（默认 `http://127.0.0.1:3200`），打包 / CLI 形态未注入生产地址 → 生产会错连本地（既有 bug）。

## 2. 目标

- server-agent 在打包 app / CLI 形态下**自动探测监听端口**：偏好 `7727`，被占则向上扫描空闲端口；dev 也统一用 7727（3100 退役）。
- 静态前端**无需知道后端端口**即可连通。
- server-main 基址**按环境切换**：dev → 本地 `3200`；分发版（打包 / CLI）→ 生产 `https://api.meshbot.app`；`MESHBOT_CLOUD_URL` 显式设置永远最高优先级。

### 非目标

- 不改 host 绑定（保持 `0.0.0.0`；收紧到 127.0.0.1 列为后续可选加固）。
- 不动 web-main 自身云前端地址（独立部署，不属于打包 agent app）。
- 不动 server-main 的 Nacos 配置。
- 不在本仓库内完成 `api.meshbot.app` 的反代搭建（infra 仓库待办，见 §7）。

## 3. 核心设计：同源伺服消除端口发现难题

关键洞察：server-agent **已经能在自己端口上伺服 web-agent 静态前端**——`apps/server-agent/src/static.module.ts` 通过 `ServeStaticModule` 提供前端资源（查找顺序：`MESHBOT_WEB_AGENT_DIR` env → `dist/../web-agent` → `dist/../../web-agent/out`）。

因此只要让**启动器加载 server-agent 端口本身**、前端改用**同源相对地址**（`window.location.origin`），「静态前端如何发现动态端口」的难题被直接消除——前端就是从那个端口被伺服出来的，API/WS 全相对到同一 origin，端口随便变都成立，且天然无跨域。

这同时让桌面端**冗余的 3101 静态服务器**（`apps/desktop/src/static-server.ts`）可以删除：当前桌面端窗口加载 3101、前端再硬连 3100，纯属历史耦合；改为窗口直接加载 server-agent 端口即可。

## 4. 组件与数据流

### 4.1 server-agent — 端口自检 + 上报

- **端口自检**（新 `utils/resolve-port.ts`）：`MESHBOT_PORT` 显式设置则严格使用（非法抛错、占用交给 `app.listen` 报错）；未设置则 `findAvailablePort(7727, host)` 向上扫描首个空闲端口、全占满退回 OS 随机端口。`main.ts` 改 `const port = await resolvePort(host)`。`env.schema.ts` 的 `MESHBOT_PORT` 改 optional。
- **端口上报**（新 `utils/report-port.ts`）：`app.listen` 成功后 `reportPort(meshbotDir, port)` 双路上报——
  - **端口文件**：原子写 `<meshbotDir>/agent.port`，内容 `{port,pid}`（CLI 等无 IPC 通道的启动器用）。
  - **IPC**：若 `process.send` 存在（被 fork），发 `{type:"meshbot:listening",port}`（桌面端用）。
  - stdout 现有日志行保留。

### 4.2 web-common / web-agent — 同源 baseURL

`resolveBaseURL()` 改为：开发期读构建期变量 `NEXT_PUBLIC_SERVER_AGENT_URL`（`apps/web-agent/.env.development` 默认 `http://localhost:7727`，因 dev 时前端在独立 Next dev server 3001、与后端跨端口）；生产静态导出不带该变量 → 落到 `window.location.origin`（同源）；SSR/构建期无 window 返回 `""`。WS（`socket.ts`/`events-socket.ts`）经 `getBrowserApiBaseUrl()` 复用，无需单独改。

### 4.3 desktop — 同源加载

fork server-agent 时**不锁 `MESHBOT_PORT`**（让其自检）、注入 `MESHBOT_WEB_AGENT_DIR`（打包好的前端目录，供同源伺服）、注入 `MESHBOT_CLOUD_URL ?? https://api.meshbot.app`（显式设置不覆盖）；监听 IPC `meshbot:listening` 拿实际端口，`startAgentRuntime()` 返回 `{port}`；窗口加载 `http://127.0.0.1:<port>`。删除 `static-server.ts` 及 3101 相关代码。

### 4.4 cli-agent — 自检 + 环境感知

`CliConfig.port` 改 optional（undefined = 自动探测）；spawn 时不带 `-p` 则不设 `MESHBOT_PORT`、注入 `MESHBOT_HOME=dataDir`（**修复既有 bug**：原传 `MESHBOT_DATA_DIR`，server-agent 实际只读 `MESHBOT_HOME`，导致 `--data-dir` 失效）、注入 `resolveCloudUrl()` 决定的云端基址；启动后清陈旧端口文件 → 等 `agent.port` 出现 → 读端口 → 健康检查 → 打印 URL。`status` 同样读端口文件。

### 4.5 server-main 基址的「生产 vs dev」决策放在启动器

server-agent 自身保持纯 env 驱动、不做分发检测（env.schema 默认 `http://127.0.0.1:3200` 仅供 `pnpm dev:server-agent`）。决策点在**启动器**（它才知道自己是不是分发版）：

- **桌面打包**：fork 注入 `https://api.meshbot.app`。
- **CLI**：`resolveCloudUrl()` 用「向上找 `pnpm-workspace.yaml`」判断是否在 monorepo 源码内——源码运行（`pnpm dev:cli-agent`）→ 本地 3200；分发安装版 → `https://api.meshbot.app`。
- `MESHBOT_CLOUD_URL` 显式设置任何时候最高优先级（自托管 / staging）。

## 5. 关键契约（跨组件）

| 契约 | 值 | 生产者 → 消费者 |
|------|----|----------------|
| 偏好端口 | `PREFERRED_PORT = 7727` | resolve-port |
| 端口文件 | `agent.port`，JSON `{port,pid}`，原子写 | server-agent → cli-agent |
| IPC 消息 | `{type:"meshbot:listening",port}` | server-agent → desktop |
| 同源伺服目录 | `MESHBOT_WEB_AGENT_DIR` | desktop → server-agent StaticModule |
| 生产云端基址 | `https://api.meshbot.app` | desktop / cli → server-agent |
| 开发前端后端地址 | `NEXT_PUBLIC_SERVER_AGENT_URL=http://localhost:7727` | web-agent 构建期 |

## 6. 错误处理与边界

- **端口探测 TOCTOU**：探测（短暂 bind 释放）与 `app.listen` 之间存在极小竞争窗口；单用户本地应用可接受。
- **陈旧端口文件**：CLI 启动前 `clearPortFile`，再等 server-agent 写新文件，避免读到上轮端口。
- **CLI 与 server-agent 端口文件目录一致性**：CLI 注入 `MESHBOT_HOME=dataDir`，server-agent `resolveMeshbotDir()` 写到同一目录，CLI 从同目录读。
- **显式 MESHBOT_PORT**：严格语义，占用即 `app.listen` 报错退出（Docker / 固定端口契约）。
- **CLI 无前端**：server-agent npm 包 `files:['dist']` 不含 web-agent，故 CLI 形态默认 API-only（headless，符合现状）；若要 CLI 也伺服 UI，需另把前端打进 server-agent 包（本期非目标）。

## 7. 外部依赖（infra 待办）

`api.meshbot.app` 的 DNS + 反向代理（nginx，参照现有 `infra/nginx/conf.d/*.meta1.top.conf` 模式）转发到 server-main 容器（容器内 3200）+ TLS，需在 **infra 仓库**单独补（目前只有 `*.meta1.top`）。桌面端登录链路冒烟依赖此项就绪。属运维 / DBA 动作。

## 8. 测试策略

- **单测**：`resolvePort`（空闲/占用→次选/显式严格/非法抛错）、`writePortFile`（JSON 结构/覆盖）、`getBrowserApiBaseUrl`（dev 变量优先 / 同源 origin / SSR 空串）、`resolveCloudUrl`（显式优先 / monorepo→本地 / 分发→生产）、`port-file`（读/清/等待）。
- **boot 冒烟**：server-agent 真启，确认日志端口 + `agent.port` 内容一致（bootstrap 改动需真启验证）。
- **打包冒烟**：`pnpm run pkg:app` 后确认窗口同源加载、`/api`+`/ws` 打同一 origin、登录链路（依赖 infra 就绪）。
- **围栏**：`pnpm typecheck` / `pnpm test`（对照预存在基线判回归）/ `pnpm check` / Biome。

## 9. 形态对照（改造后）

| 形态 | server-agent 端口 | 前端来源 | 前端→后端 | server-main 基址 |
|------|------------------|---------|----------|-----------------|
| dev | 7727（自检） | Next dev :3001 | `NEXT_PUBLIC_SERVER_AGENT_URL=:7727` | `127.0.0.1:3200`（env.schema 默认） |
| 桌面打包 | 7727（自检，IPC 上报） | server-agent 同源伺服 | `window.location.origin` | `https://api.meshbot.app`（fork 注入） |
| CLI 分发 | 7727（自检，端口文件上报） | API-only（默认无前端） | — | `https://api.meshbot.app`（resolveCloudUrl） |
