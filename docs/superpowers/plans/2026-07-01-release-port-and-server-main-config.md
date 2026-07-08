# 发布配置（端口自检 + 同源伺服 + 多环境 server-main）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 server-agent 监听端口在打包 app / CLI 形态下自动探测（偏好 7727、被占则扫描），前端用同源相对地址消除端口耦合，server-main 基址按环境切换（dev 本地 3200，分发版生产 `https://api.meshbot.app`，`MESHBOT_CLOUD_URL` 可覆盖）。

**Architecture:** 用「同源伺服」直接消除"静态前端如何发现动态后端端口"的难题——server-agent 已能通过 `StaticModule`/`ServeStaticModule` 在自己端口上伺服 web-agent 静态前端，故只要启动器（桌面窗口 / CLI / 浏览器）加载 server-agent 端口、前端改用 `window.location.origin` 相对地址，端口随便变都成立。server-agent 监听后把实际端口经 **IPC（fork 场景，桌面端用）** 与 **端口文件 `<meshbotDir>/agent.port`（CLI 用）** 双路上报给启动器。server-main 基址的"是否生产"决策放在**启动器**（它才知道自己是分发版），server-agent 本身保持纯 env 驱动。

**Tech Stack:** NestJS（server-agent）、Next.js 静态导出（web-agent）、Electron + electron-builder（desktop）、commander + Node child_process（cli-agent）、Jest（server-agent / web-common 单测）、Vitest（cli-agent 单测）。

## Global Constraints

- 偏好端口常量：`PREFERRED_PORT = 7727`（dev 与发布形态统一，3100 全面退役）。
- 生产云端基址：`https://api.meshbot.app`（注意 https、`api.` 子域）。`MESHBOT_CLOUD_URL` 显式设置永远最高优先级。
- 端口文件：文件名 `agent.port`，内容 JSON `{"port":<number>,"pid":<number>}`，原子写（tmp + rename）。
- IPC 上报消息：`{ type: "meshbot:listening", port: <number> }`。
- WS namespace 字面量：`SESSION_WS_NAMESPACE = "ws/session"`、`EVENTS_WS_NAMESPACE = "ws/events"`（无前导斜杠）；前端拼接为 `${base}/${namespace}`。
- 提交信息用中文、遵循 conventional commits；公开方法写中文 JSDoc；`if` 前一行不放注释；改完代码跑 Biome（`pnpm format` / `pnpm lint`）。
- 不改 host 绑定（保持 `0.0.0.0`）；不动 web-main 自身云前端地址；不动 server-main 的 Nacos 配置；`MESHBOT_CLOUD_URL` 默认值在 server-agent 的 env.schema 中保持 `http://127.0.0.1:3200`（仅供 `pnpm dev:server-agent`）。
- 全程在 `main` 之外的特性分支工作（见 Task 0）。提交属于计划内步骤；**不向远程 push、不开 PR，除非用户另行要求**。

---

## File Structure

**新建：**
- `apps/server-agent/src/utils/resolve-port.ts` — 端口探测（`findAvailablePort` + `resolvePort`）。
- `apps/server-agent/src/utils/resolve-port.spec.ts` — 上者单测。
- `apps/server-agent/src/utils/report-port.ts` — 端口上报（写 `agent.port` 文件 + 发 IPC）。
- `apps/server-agent/src/utils/report-port.spec.ts` — 上者单测。
- `apps/web-agent/.env.development` — 开发期 `NEXT_PUBLIC_SERVER_AGENT_URL`。
- `apps/cli-agent/src/utils/cloud-url.ts` — CLI 决定注入的 `MESHBOT_CLOUD_URL`。
- `apps/cli-agent/tests/unit/cloud-url.test.ts` — 上者单测。
- `apps/cli-agent/src/utils/port-file.ts` — CLI 读 `agent.port`。
- `apps/cli-agent/tests/unit/port-file.test.ts` — 上者单测。

**修改：**
- `apps/server-agent/src/main.ts` — 接入 `resolvePort` + `reportPort`。
- `apps/server-agent/src/env.schema.ts` — `MESHBOT_PORT` 改 optional。
- `packages/web-common/src/api/client.ts` — `resolveBaseURL` 改同源/开发解析。
- `packages/web-common/src/api/client.spec.ts` — 补 `getBrowserApiBaseUrl` 单测。
- `apps/desktop/src/agent-runtime.ts` — fork 不锁端口、IPC 取端口、注入 web-agent 目录 + 云端基址。
- `apps/desktop/src/main.ts` — 打包分支直接加载 server-agent 端口，删掉 3101 静态服务。
- `apps/cli-agent/src/utils/config.ts` — `port` 改 optional（undefined = 自动探测）。
- `apps/cli-agent/tests/unit/config.test.ts` — 同步默认值断言。
- `apps/cli-agent/src/utils/process-manager.ts` — 自动端口、读端口文件、注入云端基址、修 `MESHBOT_DATA_DIR`→`MESHBOT_HOME`。
- `apps/cli-agent/src/commands/start.ts` — 去掉 `-p` 的硬默认 `"3100"`。
- `.claude/CLAUDE.md` — dev 端口 3100 → 7727 文案更新。

**删除：**
- `apps/desktop/src/static-server.ts` — 冗余的 3101 静态服务。

---

## Task 0: 准备特性分支

- [ ] **Step 1: 从 main 切出特性分支**

```bash
cd /Users/grant/Meta1/meshbot
git checkout -b feat/release-port-and-cloud-url
git status
```
Expected: 切到 `feat/release-port-and-cloud-url`，工作区干净。

---

## Task 1: server-agent 端口探测工具

**Files:**
- Create: `apps/server-agent/src/utils/resolve-port.ts`
- Test: `apps/server-agent/src/utils/resolve-port.spec.ts`

**Interfaces:**
- Produces:
  - `PREFERRED_PORT: number`（= 7727）
  - `findAvailablePort(preferred: number, host: string, maxTries?: number): Promise<number>`
  - `resolvePort(host: string): Promise<number>` — 读 `process.env.MESHBOT_PORT`：设置则严格返回（非法抛错），未设置则返回 `findAvailablePort(PREFERRED_PORT, host)`。

- [ ] **Step 1: 写失败的单测**

`apps/server-agent/src/utils/resolve-port.spec.ts`:
```ts
import net from "node:net";
import { findAvailablePort, PREFERRED_PORT, resolvePort } from "./resolve-port";

function listen(port: number, host: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(port, host, () => resolve(s));
  });
}

function close(s: net.Server): Promise<void> {
  return new Promise((r) => s.close(() => r()));
}

describe("findAvailablePort", () => {
  it("偏好端口空闲时直接返回偏好端口", async () => {
    const probe = await listen(0, "127.0.0.1");
    const free = (probe.address() as net.AddressInfo).port;
    await close(probe);
    const got = await findAvailablePort(free, "127.0.0.1", 50);
    expect(got).toBe(free);
  });

  it("偏好端口被占用时跳到下一个空闲端口", async () => {
    const probe = await listen(0, "127.0.0.1");
    const occupied = (probe.address() as net.AddressInfo).port;
    const got = await findAvailablePort(occupied, "127.0.0.1", 50);
    expect(got).toBeGreaterThan(occupied);
    await close(probe);
  });
});

describe("resolvePort", () => {
  const orig = process.env.MESHBOT_PORT;
  afterEach(() => {
    if (orig === undefined) delete process.env.MESHBOT_PORT;
    else process.env.MESHBOT_PORT = orig;
  });

  it("MESHBOT_PORT 显式设置时原样返回（严格）", async () => {
    process.env.MESHBOT_PORT = "12345";
    expect(await resolvePort("127.0.0.1")).toBe(12345);
  });

  it("MESHBOT_PORT 非法时抛错", async () => {
    process.env.MESHBOT_PORT = "abc";
    await expect(resolvePort("127.0.0.1")).rejects.toThrow();
  });

  it("未设置 MESHBOT_PORT 时返回 >= PREFERRED_PORT 的端口", async () => {
    delete process.env.MESHBOT_PORT;
    const p = await resolvePort("127.0.0.1");
    expect(p).toBeGreaterThanOrEqual(PREFERRED_PORT);
  });
});
```

- [ ] **Step 2: 运行单测确认失败**

Run（根 jest 单一配置，从仓库根定向单文件）: `pnpm test -- apps/server-agent/src/utils/resolve-port.spec.ts`
Expected: FAIL，报 `Cannot find module './resolve-port'`。

- [ ] **Step 3: 写最小实现**

`apps/server-agent/src/utils/resolve-port.ts`:
```ts
import net from "node:net";

/** server-agent 偏好监听端口；dev 与发布形态统一用它。 */
export const PREFERRED_PORT = 7727;

/** 探测单个端口在指定 host 上是否空闲（短暂 bind 后立即释放）。 */
function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** OS 分配一个空闲端口（全部偏好区间被占满时的兜底）。 */
function osAssignedPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 从 preferred 起向上扫描首个空闲端口，最多试 maxTries 个；
 * 全被占用则退回 OS 分配的随机空闲端口。
 */
export async function findAvailablePort(
  preferred: number,
  host: string,
  maxTries = 100,
): Promise<number> {
  for (let p = preferred; p < preferred + maxTries && p <= 65535; p++) {
    if (await isPortFree(p, host)) return p;
  }
  return osAssignedPort(host);
}

/**
 * 解析 server-agent 实际监听端口。
 * - `MESHBOT_PORT` 显式设置：严格返回该端口（非法值抛错；占用与否交给 app.listen 决定）。
 * - 未设置：偏好 PREFERRED_PORT，被占则向上探测空闲端口。
 */
export async function resolvePort(host: string): Promise<number> {
  const explicit = process.env.MESHBOT_PORT;
  if (explicit !== undefined && explicit !== "") {
    const p = Number(explicit);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(`MESHBOT_PORT 非法（需 1-65535 整数）：${explicit}`);
    }
    return p;
  }
  return findAvailablePort(PREFERRED_PORT, host);
}
```

- [ ] **Step 4: 运行单测确认通过**

Run: `pnpm test -- apps/server-agent/src/utils/resolve-port.spec.ts`
Expected: PASS（5 个用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add apps/server-agent/src/utils/resolve-port.ts apps/server-agent/src/utils/resolve-port.spec.ts
git commit -m "feat(server-agent): 新增端口自检工具（偏好 7727、占用则探测）"
```

---

## Task 2: server-agent 端口上报 + bootstrap 接线

**Files:**
- Create: `apps/server-agent/src/utils/report-port.ts`
- Test: `apps/server-agent/src/utils/report-port.spec.ts`
- Modify: `apps/server-agent/src/main.ts`
- Modify: `apps/server-agent/src/env.schema.ts`

**Interfaces:**
- Consumes: `resolvePort` from Task 1。
- Produces:
  - `PORT_FILE_NAME: string`（= `"agent.port"`）
  - `writePortFile(meshbotDir: string, port: number, pid: number): void`
  - `reportPort(meshbotDir: string, port: number): void` — 写端口文件 + 若 `process.send` 存在则发 IPC `{type:"meshbot:listening",port}`。

- [ ] **Step 1: 写失败的单测**

`apps/server-agent/src/utils/report-port.spec.ts`:
```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PORT_FILE_NAME, writePortFile } from "./report-port";

describe("writePortFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "meshbot-port-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("把端口与 pid 写成 JSON 到 agent.port", () => {
    writePortFile(dir, 7727, 4242);
    const raw = readFileSync(path.join(dir, PORT_FILE_NAME), "utf8");
    expect(JSON.parse(raw)).toEqual({ port: 7727, pid: 4242 });
  });

  it("重复写入覆盖旧内容", () => {
    writePortFile(dir, 7727, 1);
    writePortFile(dir, 7800, 2);
    const raw = readFileSync(path.join(dir, PORT_FILE_NAME), "utf8");
    expect(JSON.parse(raw)).toEqual({ port: 7800, pid: 2 });
  });
});
```

- [ ] **Step 2: 运行单测确认失败**

Run: `pnpm test -- apps/server-agent/src/utils/report-port.spec.ts`
Expected: FAIL，报 `Cannot find module './report-port'`。

- [ ] **Step 3: 写最小实现**

`apps/server-agent/src/utils/report-port.ts`:
```ts
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 端口文件名（位于 meshbotDir 下）。 */
export const PORT_FILE_NAME = "agent.port";

/**
 * 原子写入 `<meshbotDir>/agent.port`（tmp + rename），内容 `{port,pid}`。
 * 供 CLI 等无 IPC 通道的启动器发现 server-agent 实际监听端口。
 */
export function writePortFile(
  meshbotDir: string,
  port: number,
  pid: number,
): void {
  const target = path.join(meshbotDir, PORT_FILE_NAME);
  const tmp = `${target}.${pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ port, pid }), "utf8");
  renameSync(tmp, target);
}

/**
 * 端口就绪后统一上报：
 * - 写端口文件（所有形态）；
 * - 若被 fork（`process.send` 存在），额外发 IPC 消息给父进程（桌面端用）。
 */
export function reportPort(meshbotDir: string, port: number): void {
  writePortFile(meshbotDir, port, process.pid);
  if (process.send) {
    process.send({ type: "meshbot:listening", port });
  }
}
```

- [ ] **Step 4: 运行单测确认通过**

Run: `pnpm test -- apps/server-agent/src/utils/report-port.spec.ts`
Expected: PASS。

- [ ] **Step 5: 接入 bootstrap（main.ts）**

修改 `apps/server-agent/src/main.ts`：在文件顶部 import 区加入：
```ts
import { reportPort } from "./utils/report-port";
import { resolvePort } from "./utils/resolve-port";
```
把：
```ts
  const port = Number(process.env.MESHBOT_PORT ?? 3100);
  const host = "0.0.0.0";
```
改为：
```ts
  const host = "0.0.0.0";
  const port = await resolvePort(host);
```
把：
```ts
  await app.listen(port, host);
  console.log(`Agent running on http://${host}:${port}`);
```
改为：
```ts
  await app.listen(port, host);
  reportPort(meshbotDir, port);
  console.log(`Agent running on http://${host}:${port}`);
```
（`meshbotDir` 已在前面 `const meshbotDir = resolveMeshbotDir();` 定义，直接复用。）

- [ ] **Step 6: env.schema 把 MESHBOT_PORT 改 optional**

修改 `apps/server-agent/src/env.schema.ts`，把：
```ts
  /** server-agent HTTP 端口，默认 3100 */
  MESHBOT_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
```
改为：
```ts
  /** server-agent HTTP 端口；未设置时由 resolvePort 偏好 7727 自动探测 */
  MESHBOT_PORT: z.coerce.number().int().min(1).max(65535).optional(),
```

- [ ] **Step 7: 类型检查**

Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 无错误。

- [ ] **Step 8: boot 冒烟（bootstrap 改动需真启验证）**

```bash
pnpm --filter @meshbot/server-agent build
( node apps/server-agent/dist/main.js & echo $! > /tmp/sa.pid ; sleep 6 ; \
  cat "$(node -e "const{resolveMeshbotDir}=require('./apps/server-agent/dist/utils/meshbot-dir');console.log(resolveMeshbotDir())")/agent.port" ; \
  kill "$(cat /tmp/sa.pid)" )
```
Expected：stdout 出现 `Agent running on http://0.0.0.0:7727`（若 7727 被占则为更大端口），且打印出的 `agent.port` 内容为 `{"port":7727,...}`。读**完整输出**确认端口一致，不要只看 tail。

- [ ] **Step 9: 提交**

```bash
git add apps/server-agent/src/utils/report-port.ts apps/server-agent/src/utils/report-port.spec.ts apps/server-agent/src/main.ts apps/server-agent/src/env.schema.ts
git commit -m "feat(server-agent): 监听后上报实际端口（agent.port 文件 + fork IPC），端口改自检"
```

---

## Task 3: 前端同源 baseURL

**Files:**
- Modify: `packages/web-common/src/api/client.ts`
- Modify: `packages/web-common/src/api/client.spec.ts`
- Create: `apps/web-agent/.env.development`

**Interfaces:**
- Produces（行为变更）：`getBrowserApiBaseUrl()` — 有 `process.env.NEXT_PUBLIC_SERVER_AGENT_URL`（开发）时返回该值；否则返回 `window.location.origin`（生产同源）；SSR / 无 window 且无 dev 变量时返回 `""`。

- [ ] **Step 1: 写失败的单测**

在 `packages/web-common/src/api/client.spec.ts` 顶部 import 加上 `getBrowserApiBaseUrl`：
```ts
import {
  addAccount,
  clearAccessToken,
  getAccessToken,
  getActiveAccountId,
  getBrowserApiBaseUrl,
  listAccounts,
  removeAccount,
  setActiveAccount,
  unwrapEnvelope,
} from "./client";
```
在文件末尾追加：
```ts
// ---------------------------------------------------------------------------
// getBrowserApiBaseUrl 同源 / 开发解析单测
// 测试环境为 node（无 jsdom），手动 stub globalThis.window 与 NEXT_PUBLIC 变量。
// ---------------------------------------------------------------------------
describe("getBrowserApiBaseUrl（同源 / 开发解析）", () => {
  const origWindow = globalThis.window;
  const origEnv = process.env.NEXT_PUBLIC_SERVER_AGENT_URL;

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    (globalThis as any).window = origWindow;
    if (origEnv === undefined) delete process.env.NEXT_PUBLIC_SERVER_AGENT_URL;
    else process.env.NEXT_PUBLIC_SERVER_AGENT_URL = origEnv;
  });

  it("设置 NEXT_PUBLIC_SERVER_AGENT_URL（开发）时优先返回该地址", () => {
    process.env.NEXT_PUBLIC_SERVER_AGENT_URL = "http://localhost:7727";
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    (globalThis as any).window = { location: { origin: "http://127.0.0.1:9999" } };
    expect(getBrowserApiBaseUrl()).toBe("http://localhost:7727");
  });

  it("无 dev 变量、有 window 时返回当前页面 origin（同源）", () => {
    delete process.env.NEXT_PUBLIC_SERVER_AGENT_URL;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    (globalThis as any).window = { location: { origin: "http://127.0.0.1:7727" } };
    expect(getBrowserApiBaseUrl()).toBe("http://127.0.0.1:7727");
  });

  it("无 dev 变量、无 window（SSR）时返回空串", () => {
    delete process.env.NEXT_PUBLIC_SERVER_AGENT_URL;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    (globalThis as any).window = undefined;
    expect(getBrowserApiBaseUrl()).toBe("");
  });
});
```

- [ ] **Step 2: 运行单测确认失败**

Run: `pnpm --filter @meshbot/web-common test -- client.spec.ts`
Expected: FAIL（新 describe 三个用例不通过——当前实现返回硬编码 `:3100`）。

- [ ] **Step 3: 写实现**

修改 `packages/web-common/src/api/client.ts`，把：
```ts
const DEFAULT_API_URL = "http://127.0.0.1:3100";

function resolveBaseURL(): string {
  if (typeof window === "undefined") return DEFAULT_API_URL;
  const { protocol, hostname } = window.location;
  if (protocol === "http:" || protocol === "https:") {
    const apiHost =
      hostname === "localhost" || hostname === "[::1]" ? "127.0.0.1" : hostname;
    return `${protocol}//${apiHost}:3100`;
  }
  return DEFAULT_API_URL;
}
```
改为：
```ts
/**
 * 解析后端（server-agent）基址。
 *
 * - 开发：web-agent 跑在独立 Next dev server，与 server-agent 跨端口，
 *   通过构建期变量 `NEXT_PUBLIC_SERVER_AGENT_URL` 显式指向后端。
 * - 生产：前端由 server-agent 同源伺服（静态导出不带该变量），用当前页面
 *   `window.location.origin`，API / WS 全部相对到伺服源——后端端口随便变都成立。
 * - SSR / 构建期（无 window 且无 dev 变量）：返回空串（静态导出下不会发起真实请求）。
 */
function resolveBaseURL(): string {
  const devUrl = process.env.NEXT_PUBLIC_SERVER_AGENT_URL;
  if (devUrl) return devUrl;
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
}
```

- [ ] **Step 4: 运行单测确认通过**

Run: `pnpm --filter @meshbot/web-common test -- client.spec.ts`
Expected: PASS（含原有 unwrapEnvelope / 多账号 store 用例 + 新增 3 个）。

- [ ] **Step 5: 加开发期环境变量**

Create `apps/web-agent/.env.development`:
```
# 开发期 web-agent（Next dev server，端口 3001）跨端口访问 server-agent。
# 生产静态导出不读本文件 → 前端落到同源 window.location.origin。
NEXT_PUBLIC_SERVER_AGENT_URL=http://localhost:7727
```

- [ ] **Step 6: 提交**

```bash
git add packages/web-common/src/api/client.ts packages/web-common/src/api/client.spec.ts apps/web-agent/.env.development
git commit -m "feat(web-common): 前端基址改同源解析，开发期走 NEXT_PUBLIC_SERVER_AGENT_URL"
```

---

## Task 4: 桌面端同源改造

**Files:**
- Modify: `apps/desktop/src/agent-runtime.ts`
- Modify: `apps/desktop/src/main.ts`
- Delete: `apps/desktop/src/static-server.ts`

**Interfaces:**
- Consumes: server-agent 的 IPC 消息 `{type:"meshbot:listening",port}`（Task 2）、`MESHBOT_WEB_AGENT_DIR` 同源伺服（已存在的 `StaticModule` env 覆盖）。
- Produces: `startAgentRuntime(): Promise<{ port: number }>`（签名变更：原 `Promise<void>`）。

> 说明：Electron 主进程 fork 胶水无法做有意义的单元测试（vitest 跑不动真 fork + 真窗口），故本任务以 typecheck + build + 手动打包冒烟验证，并显式说明无单测原因——不写假装通过的测试。

- [ ] **Step 1: 先确认没有别处引用将删除的模块**

Run: `grep -rn "static-server\|startStaticServer" apps/desktop/src`
Expected: 仅 `main.ts` 与 `static-server.ts` 自身命中；无测试或其它模块引用。若有额外引用，一并在下面步骤处理。

- [ ] **Step 2: 改写 agent-runtime.ts**

整体替换 `apps/desktop/src/agent-runtime.ts` 内容为：
```ts
import { type ChildProcess, fork } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PROD_CLOUD_URL = "https://api.meshbot.app";
const READINESS_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const HEALTH_PATH = "/api/health";

let child: ChildProcess | null = null;
let intentionalStop = false;

/**
 * 启动内置 server-agent 子进程（仅 packaged 模式调用；dev 由开发者自行起服务）。
 * - 复用 Electron 自带 Node 运行时（fork 默认 ELECTRON_RUN_AS_NODE）
 * - 不锁 MESHBOT_PORT → server-agent 自动偏好 7727、占用则探测
 * - 注入 MESHBOT_WEB_AGENT_DIR（打包好的前端），server-agent 同源伺服 UI
 * - 注入 MESHBOT_CLOUD_URL 默认生产云端（显式设置则不覆盖）
 * - 监听 IPC `meshbot:listening` 拿实际端口，再过一次 health 确认 HTTP 就绪
 * - 子进程侧在 IPC 断开时自退（见 server-agent main.ts），壳崩溃不留孤儿
 */
export async function startAgentRuntime(): Promise<{ port: number }> {
  if (child) throw new Error("agent runtime already started");

  const entry = require.resolve("@meshbot/server-agent");
  const meshbotHome = path.join(os.homedir(), ".meshbot");
  const webAgentDir = path.join(__dirname, "web-agent");

  intentionalStop = false;
  child = fork(entry, [], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      MESHBOT_HOME: meshbotHome,
      MESHBOT_WEB_AGENT_DIR: webAgentDir,
      MESHBOT_CLOUD_URL: process.env.MESHBOT_CLOUD_URL ?? PROD_CLOUD_URL,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[agent] ${chunk}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[agent] ${chunk}`);
  });

  const exitPromise = new Promise<never>((_, reject) => {
    child?.once("exit", (code, signal) => {
      child = null;
      if (intentionalStop) return;
      reject(
        new Error(
          `agent process exited unexpectedly (code=${code}, signal=${signal})`,
        ),
      );
    });
  });

  const portPromise = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("agent 未在超时内上报监听端口")),
      READINESS_TIMEOUT_MS,
    );
    child?.on("message", (msg: unknown) => {
      if (
        msg &&
        typeof msg === "object" &&
        (msg as { type?: string }).type === "meshbot:listening"
      ) {
        clearTimeout(timer);
        resolve((msg as { port: number }).port);
      }
    });
  });

  const port = await Promise.race([portPromise, exitPromise]);
  await Promise.race([waitForReady(port, READINESS_TIMEOUT_MS), exitPromise]);
  return { port };
}

export function stopAgentRuntime(): void {
  if (!child) return;
  intentionalStop = true;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  child = null;
}

function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: HEALTH_PATH, timeout: 1500 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve();
          scheduleRetry();
        },
      );
      req.on("error", scheduleRetry);
      req.on("timeout", () => {
        req.destroy();
        scheduleRetry();
      });
    };
    const scheduleRetry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`agent health check timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
  });
}
```

- [ ] **Step 3: 改 main.ts（删 3101，加载 server-agent 端口）**

修改 `apps/desktop/src/main.ts`：

删除这行 import：
```ts
import { startStaticServer } from "./static-server";
```
删除 `staticServer` 变量声明：
```ts
let staticServer: { server: import("node:http").Server; port: number } | null =
  null;
```
把 `getAgentUrl()` 的打包分支：
```ts
  // packaged：server-agent 与 web-agent 都在 app 内 —— 先把内置 server-agent
  // fork 起来并等就绪，再起静态 UI server 加载打包好的 html
  await startAgentRuntime();

  const webAgentPath = path.join(__dirname, "web-agent");
  staticServer = await startStaticServer(webAgentPath);
  return `http://127.0.0.1:${staticServer.port}`;
```
改为：
```ts
  // packaged：fork 内置 server-agent（自检端口 + 同源伺服打包好的 web-agent），
  // 窗口直接加载它的端口，前端走同源相对地址
  const { port } = await startAgentRuntime();
  return `http://127.0.0.1:${port}`;
```
把 `window-all-closed` 里的：
```ts
app.on("window-all-closed", () => {
  staticServer?.server.close();
  staticServer = null;
  if (process.platform !== "darwin") {
    stopAgentRuntime();
    app.quit();
  }
});
```
改为：
```ts
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    stopAgentRuntime();
    app.quit();
  }
});
```

- [ ] **Step 4: 删除冗余静态服务**

```bash
git rm apps/desktop/src/static-server.ts
```

- [ ] **Step 5: 类型检查 + 既有测试**

Run: `pnpm --filter @meshbot/desktop typecheck && pnpm --filter @meshbot/desktop test`
Expected: typecheck 无错误；vitest 无失败（若桌面端无测试文件，vitest 报 "no test files" 视为通过）。读完整输出确认无遗留对已删除符号的引用。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/agent-runtime.ts apps/desktop/src/main.ts
git commit -m "feat(desktop): 同源加载 server-agent 端口，删除冗余 3101 静态服务，注入云端基址"
```

- [ ] **Step 7: 打包冒烟（手动，发布前必做）**

```bash
pnpm run pkg:app
```
然后打开生成的 app，确认：窗口正常加载 UI；DevTools 里 `window.location.origin` = `http://127.0.0.1:7727`（或探测到的端口）；网络面板里 `/api/*` 与 `/ws/*` 请求打到同一 origin 且成功；登录功能正常（验证 `MESHBOT_CLOUD_URL` 已是 `https://api.meshbot.app`，需 infra 反代就绪——见 Task 7）。

---

## Task 5: CLI 端口自检 + 云端基址注入

**Files:**
- Modify: `apps/cli-agent/src/utils/config.ts`
- Modify: `apps/cli-agent/tests/unit/config.test.ts`
- Create: `apps/cli-agent/src/utils/cloud-url.ts`
- Create: `apps/cli-agent/tests/unit/cloud-url.test.ts`
- Create: `apps/cli-agent/src/utils/port-file.ts`
- Create: `apps/cli-agent/tests/unit/port-file.test.ts`
- Modify: `apps/cli-agent/src/utils/process-manager.ts`
- Modify: `apps/cli-agent/src/commands/start.ts`

**Interfaces:**
- Consumes: server-agent 写的 `agent.port`（Task 2），`MESHBOT_HOME` / `MESHBOT_PORT` / `MESHBOT_CLOUD_URL` 契约。
- Produces:
  - `resolveCloudUrl(opts?: { env?: NodeJS.ProcessEnv; cwd?: string }): string`
  - `readPortInfo(dataDir: string): { port: number; pid: number } | null`
  - `clearPortFile(dataDir: string): void`
  - `waitForPortFile(dataDir: string, timeoutMs: number): Promise<{ port: number; pid: number }>`
  - `CliConfig.port` 改为 `number | undefined`（undefined = 自动探测）。

- [ ] **Step 1: 写 cloud-url 失败单测**

`apps/cli-agent/tests/unit/cloud-url.test.ts`:
```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCloudUrl } from "../../src/utils/cloud-url.js";

describe("resolveCloudUrl", () => {
  it("显式 MESHBOT_CLOUD_URL 最高优先级", () => {
    expect(
      resolveCloudUrl({
        env: { MESHBOT_CLOUD_URL: "https://x.example" },
        cwd: tmpdir(),
      }),
    ).toBe("https://x.example");
  });

  it("monorepo 源码内（有 pnpm-workspace.yaml）→ 本地 3200", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ws-"));
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []");
    const sub = path.join(root, "apps", "cli-agent");
    expect(resolveCloudUrl({ env: {}, cwd: sub })).toBe(
      "http://127.0.0.1:3200",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("分发安装版（无 workspace 标记）→ 生产 api.meshbot.app", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dist-"));
    expect(resolveCloudUrl({ env: {}, cwd: dir })).toBe(
      "https://api.meshbot.app",
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 写 port-file 失败单测**

`apps/cli-agent/tests/unit/port-file.test.ts`:
```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPortFile,
  readPortInfo,
  waitForPortFile,
} from "../../src/utils/port-file.js";

describe("port-file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "meshbot-cli-port-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readPortInfo 解析 agent.port", () => {
    writeFileSync(
      path.join(dir, "agent.port"),
      JSON.stringify({ port: 7727, pid: 42 }),
    );
    expect(readPortInfo(dir)).toEqual({ port: 7727, pid: 42 });
  });

  it("readPortInfo 文件不存在返回 null", () => {
    expect(readPortInfo(dir)).toBeNull();
  });

  it("clearPortFile 删除文件后 readPortInfo 返回 null", () => {
    writeFileSync(
      path.join(dir, "agent.port"),
      JSON.stringify({ port: 1, pid: 2 }),
    );
    clearPortFile(dir);
    expect(readPortInfo(dir)).toBeNull();
  });

  it("waitForPortFile 在文件出现后返回端口信息", async () => {
    setTimeout(() => {
      writeFileSync(
        path.join(dir, "agent.port"),
        JSON.stringify({ port: 7800, pid: 7 }),
      );
    }, 150);
    await expect(waitForPortFile(dir, 3000)).resolves.toEqual({
      port: 7800,
      pid: 7,
    });
  });
});
```

- [ ] **Step 3: 运行确认两组单测失败**

Run: `pnpm --filter @meshbot/agent test`
Expected: FAIL，报找不到 `cloud-url` / `port-file` 模块。

- [ ] **Step 4: 实现 cloud-url.ts**

`apps/cli-agent/src/utils/cloud-url.ts`:
```ts
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROD_CLOUD_URL = "https://api.meshbot.app";
const DEV_CLOUD_URL = "http://127.0.0.1:3200";

/** 向上查找 pnpm-workspace.yaml，判断是否在 monorepo 源码内运行（= 开发）。 */
function inMonorepoSource(startDir: string): boolean {
  let dir = startDir;
  while (true) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * 决定 CLI 注入给 server-agent 的 MESHBOT_CLOUD_URL：
 * - 显式 env 最高优先级（自托管 / staging）；
 * - monorepo 源码运行（pnpm dev:cli-agent）→ 本地 3200；
 * - 分发安装版 → 生产 api.meshbot.app。
 */
export function resolveCloudUrl(opts?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): string {
  const env = opts?.env ?? process.env;
  if (env.MESHBOT_CLOUD_URL) return env.MESHBOT_CLOUD_URL;
  const cwd = opts?.cwd ?? path.dirname(fileURLToPath(import.meta.url));
  return inMonorepoSource(cwd) ? DEV_CLOUD_URL : PROD_CLOUD_URL;
}
```

- [ ] **Step 5: 实现 port-file.ts**

`apps/cli-agent/src/utils/port-file.ts`:
```ts
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

export interface PortInfo {
  port: number;
  pid: number;
}

function portFilePath(dataDir: string): string {
  return path.join(dataDir, "agent.port");
}

/** 读 `<dataDir>/agent.port`；不存在或损坏返回 null。 */
export function readPortInfo(dataDir: string): PortInfo | null {
  const f = portFilePath(dataDir);
  if (!existsSync(f)) return null;
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8")) as Partial<PortInfo>;
    if (typeof parsed.port === "number") {
      return {
        port: parsed.port,
        pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      };
    }
  } catch {
    // malformed → null
  }
  return null;
}

/** 删除端口文件（启动前清理陈旧记录，避免读到上轮端口）。 */
export function clearPortFile(dataDir: string): void {
  const f = portFilePath(dataDir);
  if (existsSync(f)) {
    try {
      unlinkSync(f);
    } catch {
      // ignore
    }
  }
}

/** 轮询等待 server-agent 写出 agent.port；超时抛错。 */
export async function waitForPortFile(
  dataDir: string,
  timeoutMs: number,
): Promise<PortInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readPortInfo(dataDir);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待 agent.port 超时（${timeoutMs / 1000}s）`);
}
```

- [ ] **Step 6: config.ts 把 port 改 optional**

修改 `apps/cli-agent/src/utils/config.ts`：

接口 `CliConfig`：
```ts
export interface CliConfig {
  port: number;
  dataDir: string;
```
改为：
```ts
export interface CliConfig {
  /** 监听端口；undefined = 交给 server-agent 自动探测（偏好 7727） */
  port?: number;
  dataDir: string;
```
`DEFAULT_CONFIG`：
```ts
const DEFAULT_CONFIG: CliConfig = {
  port: 3100,
  dataDir: path.join(homedir(), ".meshbot"),
  serverAgentPath: null,
  logLevel: "info",
  autoStart: false,
};
```
改为（去掉 port 字段，默认即自动探测）：
```ts
const DEFAULT_CONFIG: CliConfig = {
  dataDir: path.join(homedir(), ".meshbot"),
  serverAgentPath: null,
  logLevel: "info",
  autoStart: false,
};
```

- [ ] **Step 7: 同步 config.test.ts 默认值断言**

修改 `apps/cli-agent/tests/unit/config.test.ts` 的首个用例：
```ts
  it("returns default config when file does not exist", () => {
    const config = readConfig();
    expect(config.port).toBe(3100);
    expect(config.logLevel).toBe("info");
  });
```
改为：
```ts
  it("returns default config when file does not exist", () => {
    const config = readConfig();
    expect(config.port).toBeUndefined();
    expect(config.logLevel).toBe("info");
  });
```

- [ ] **Step 8: 重写 process-manager 的 startAgent / getAgentStatus**

修改 `apps/cli-agent/src/utils/process-manager.ts`：

顶部 import 区追加：
```ts
import { resolveCloudUrl } from "./cloud-url.js";
import { clearPortFile, readPortInfo, waitForPortFile } from "./port-file.js";
```
把整个 `startAgent` 函数替换为：
```ts
export async function startAgent(options: StartOptions = {}): Promise<void> {
  const runningPid = getRunningPid();
  if (runningPid !== null) {
    const cfg = readConfig();
    const info = readPortInfo(cfg.dataDir);
    const portStr = info ? String(info.port) : "unknown";
    console.log(`Agent already running on port ${portStr} (PID: ${runningPid})`);
    return;
  }

  const config = readConfig();
  const explicitPort = options.port ?? config.port;
  const dataDir = options.dataDir ?? config.dataDir;
  const serverAgentRoot = resolveServerAgentPath();
  const serverAgentMain = getServerAgentMainPath();

  log(
    "cli",
    `Starting server-agent: ${serverAgentMain} (port=${explicitPort ?? "auto"}, dataDir=${dataDir})`,
  );

  clearPortFile(dataDir);

  const child = spawn("node", [serverAgentMain], {
    cwd: serverAgentRoot,
    stdio: options.daemon ? "ignore" : "inherit",
    env: {
      ...process.env,
      MESHBOT_HOME: dataDir,
      MESHBOT_CLOUD_URL: resolveCloudUrl(),
      ...(explicitPort ? { MESHBOT_PORT: String(explicitPort) } : {}),
    },
    detached: options.daemon ?? false,
  });

  if (child.pid === undefined || child.pid === null) {
    throw new Error("Failed to spawn server-agent process");
  }
  writePid(child.pid);

  if (options.daemon) {
    child.unref();
  }

  try {
    const { port } = await waitForPortFile(dataDir, 30000);
    await pollHttpReady(`http://127.0.0.1:${port}/api/setup-status`, 30000);
    console.log(`Agent started on http://127.0.0.1:${port}`);
  } catch (err) {
    clearPid();
    if (child.kill) child.kill();
    throw new Error(
      `Agent failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```
把整个 `getAgentStatus` 函数替换为：
```ts
export async function getAgentStatus(): Promise<void> {
  const pid = getRunningPid();
  if (pid === null) {
    console.log("Agent is not running");
    return;
  }

  const config = readConfig();
  const info = readPortInfo(config.dataDir);
  if (!info) {
    console.log(`Status: running (PID: ${pid})`);
    console.log(`Health: unreachable（未找到 agent.port）`);
    return;
  }

  const healthUrl = `http://127.0.0.1:${info.port}/api/setup-status`;
  try {
    const res = await fetch(healthUrl);
    const data = (await res.json()) as { initialized?: boolean };
    console.log(`Status: running`);
    console.log(`PID: ${pid}`);
    console.log(`Port: ${info.port}`);
    console.log(`Data dir: ${config.dataDir}`);
    console.log(`Health: OK`);
    console.log(`Setup: ${data.initialized ? "initialized" : "needs setup"}`);
  } catch {
    console.log(`Status: running (PID: ${pid})`);
    console.log(`Health: unreachable`);
  }
}
```

- [ ] **Step 9: start.ts 去掉端口硬默认**

修改 `apps/cli-agent/src/commands/start.ts`，把：
```ts
    .option("-p, --port <number>", "Port to listen on", "3100")
```
改为：
```ts
    .option("-p, --port <number>", "Port to listen on (default: auto-detect 7727)")
```

- [ ] **Step 10: 运行 CLI 全部单测**

Run: `pnpm --filter @meshbot/agent test`
Expected: PASS（cloud-url 3 + port-file 4 + 既有 config / pid-file / path-resolver / cli-binary 集成测试全绿）。读完整输出；若集成测试 `cli-binary.test.ts` 因端口/启动行为变化失败，按实际报错修正（多为断言里的端口或启动日志文案）。

- [ ] **Step 11: 提交**

```bash
git add apps/cli-agent/src/utils/cloud-url.ts apps/cli-agent/tests/unit/cloud-url.test.ts apps/cli-agent/src/utils/port-file.ts apps/cli-agent/tests/unit/port-file.test.ts apps/cli-agent/src/utils/config.ts apps/cli-agent/tests/unit/config.test.ts apps/cli-agent/src/utils/process-manager.ts apps/cli-agent/src/commands/start.ts
git commit -m "feat(cli-agent): 端口交给 server-agent 自检并读 agent.port，注入环境感知云端基址，修 MESHBOT_HOME"
```

---

## Task 6: 文档与开发脚本端口文案

**Files:**
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: 更新 CLAUDE.md dev 端口文案**

修改 `.claude/CLAUDE.md` 开发命令表，把：
```
| `pnpm dev:server-agent` | 本地 Agent 后端（NestJS watch，端口 3100） |
```
改为：
```
| `pnpm dev:server-agent` | 本地 Agent 后端（NestJS watch，端口 7727，自动探测） |
```

- [ ] **Step 2: 核对没有其它硬编码 3100 残留**

Run: `grep -rn "3100" apps packages --include="*.ts" --include="*.json" --include="*.md" | grep -v node_modules | grep -v dist`
Expected: 仅剩历史注释 / 无关命中；若有功能性硬编码（如脚本里写死 3100 调后端）一并改为 7727 或同源，并在本步骤补充修改 + 说明。

- [ ] **Step 3: 提交**

```bash
git add .claude/CLAUDE.md
git commit -m "docs: dev server-agent 端口文案 3100 → 7727 自动探测"
```

---

## Task 7: 全量围栏 + infra 待办

- [ ] **Step 1: 跑全量类型检查与测试**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿。对照记忆中的预存在基线（libs/agent vitest 9 个预存在失败、e2e/boot 基础设施红）判断是否回归——只看新增失败，不被既有基线干扰。读**完整输出**而非 tail。

- [ ] **Step 2: 跑静态围栏**

Run: `pnpm check`
Expected: tx / naming / lock-tx / repo / dead / error-code 六道围栏全过（本改动不涉及 Entity/事务/锁，预期无新增违规）。

- [ ] **Step 3: Biome 格式化**

Run: `pnpm format && pnpm lint`
Expected: 无残留问题。

- [ ] **Step 4: 记录 infra 交付待办（不在本仓库代码内完成）**

在收尾说明 / commit 描述中明确：**infra 仓库需新增 `api.meshbot.app` 的 DNS + 反向代理（nginx，参照现有 `*.meta1.top.conf` 模式），转发到 server-main 容器（容器内 3200）**，并按需配 TLS。打包冒烟（Task 4 Step 7）的登录链路依赖此项就绪。此为运维 / DBA 动作，本计划不直接修改 infra。

- [ ] **Step 5: 收尾提交（如有格式化改动）**

```bash
git add -A
git commit -m "chore: 发布配置改造收尾（格式化 + 围栏）"
```

---

## Self-Review（计划自审）

- **Spec 覆盖**：① 端口自检（默认 7727、占用探测）→ Task 1+2；② 实际端口上报 → Task 2（文件）+ Task 4（IPC 消费）；③ 静态前端同源发现 → Task 3 + Task 4（窗口加载 server-agent 端口）；④ server-main 多环境基址 → Task 4（桌面注入）+ Task 5（CLI 注入）+ env.schema 保留 dev 默认；⑤ dev 统一 7727 → Task 3（前端 .env）+ Task 6（文案）+ env.schema 自检默认。全部有对应任务。
- **占位符扫描**：无 TBD / TODO；每个代码步骤含完整可粘贴代码与确切命令、预期输出。
- **类型一致性**：`reportPort(meshbotDir,port)` / `writePortFile(dir,port,pid)`（Task 2）与消费端契约一致；IPC 消息 `{type:"meshbot:listening",port}` 在 Task 2 产出、Task 4 消费，字段名一致；`agent.port` JSON `{port,pid}` 在 Task 2 写、Task 5 读，结构一致；`startAgentRuntime(): Promise<{port}>` 新签名在 Task 4 内自洽（main.ts 解构 `{ port }`）；`CliConfig.port?: number` 在 Task 5 各处按 optional 处理。
- **范围**：单一功能（发布配置）跨多 app 但共享一套契约，未拆分；host 绑定 / web-main / Nacos / infra 代码改动明确排除。
