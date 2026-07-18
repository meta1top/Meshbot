# Agent 级观察通道实施 plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development

依据 spec：`docs/superpowers/specs/2026-07-18-session-watch-mirror-design.md`（v2，唯一权威）。
分支：`feat/multi-agent-per-device`。

## Goal

**订阅了同一个 Agent 的端（无论本地还是远程），关于该 Agent 的一切都同步**：

1. **会话生命周期**（修缺口 ②）：A 设备远程给 B 创建/删除/改名的会话，B 上实时出现/消失/改名，无需刷新。
2. **推理帧**（修缺口 ①）：两端都开着会话 S，从对端继续聊时本端实时输出；中途进入能用 inflight 快照续上半截输出。
3. **HITL**：观察者也能应答确认卡 / 提问卡，先到先得，其余端卡片置为已完成。

## Architecture

三层，两级 scope，一套协议：

```
                     ┌──────────────── server-main (im.gateway) ────────────────┐
                     │  watchRoutes:     watchId → {requester, scope, ...}       │
观察者端              │  agentWatchers:   `${deviceId}:${localAgentId}` → Set<wid>│      被观察设备
(web-main 直连 /      │  sessionWatchers: `${deviceId}:${sessionId}`   → Set<wid>│      (server-agent)
 web-agent 经代理)    └──────────────────────────────────────────────────────────┘
     │                            ▲  agent.watch.start/stop            │  ▲
     │  agent.watch.start ────────┘                                    │  │
     │                            ┌─ agent.watch.forwarded ────────────┘  │
     │  ◀── agent.run.frame ──────┤    (含 watchId、scope、localAgentId)   │
     │      (watchId 寻址，fan-out)│                                       │
     │  ◀── agent.watch.accepted ─┤ ◀── agent.watch.frame（设备只发一份）──┘
     │      (inflight 快照)        │ ◀── agent.watch.accepted ─────────────┘
```

**设备侧只镜像一份**（每个 agent / 每个 session 一份），**云端按 watchers 表 fan-out**。省设备上行带宽；观察者增减不影响设备侧行为（spec §C 取舍）。

**两级 scope，同一套协议**（D8）：
- **Agent 级 watch**：订会话生命周期（低频）——`session.created/deleted/renamed/status_changed`。
- **Session 级 watch**：订推理帧（高频，仅当前打开的会话）——`SESSION_WS_EVENTS.*` 全集。

**双传输、统一契约**（D9）：前端消费同一套事件模型；本地 Agent 的生命周期事件来自 `ws/events`，远程 Agent 的来自 relay 镜像，上层处理逻辑一份。传输层合一不在本轮。

## Tech Stack

- 协议：`libs/types`（跨域，relay 线上契约）+ `libs/types-agent`（Agent 域进程内事件），zod。
- 云端：`apps/server-main/src/ws/im.gateway.ts`（NestJS WebSocketGateway，socket.io，进程内 Map 路由表）。
- 设备：`apps/server-agent`（NestJS + EventEmitter2 + `ImRelayClientService` socket.io-client）。
- 前端：`packages/web-common/src/session/`（纯逻辑共享）+ `apps/web-main` / `apps/web-agent`（Next.js + jotai + react-query）。
- 测试：Jest（root 配置，覆盖 `libs/common` + `server-agent` + `server-main` + `libs/types`）；`libs/agent` 用 vitest（本轮不涉及）。

---

## Global Constraints

### spec 锁定决策（D1-D9，verbatim）

| # | 决策 | 取值 |
|---|------|------|
| D1 | 方案 | **watch/镜像通道**（真解），非轮询降级 |
| D2 | HITL | **观察者也能应答**（control 接受 watchId 寻址，注册表绑 watchId） |
| D3 | 并发应答仲裁 | **先到先得**：首个到达服务端的应答生效并关卡；其余端收到「已由某端应答」并把卡片置为已完成 |
| D4 | 范围 | **对称**：任一端看任一端（web-main 看设备、web-agent A 看设备 B 均可） |
| D5 | watch 生命周期 | 进入 Agent 即 agent-watch、打开会话即 session-watch；离开即 unwatch；idle 5 分钟拆除；断线重连自动重 watch |
| D6 | 重复投递 | 同一客户端持有自己的 stream 期间**抑制** session-watch 的帧（不逐帧去重） |
| D7 | 中途续上 | `watch_accepted` 回包**携带 inflight 快照**（设备侧 `runner.getInflight` 现成） |
| **D8** | **watch 粒度** | **两级 scope、同一套协议**：**Agent 级**订会话生命周期（低频）；**Session 级**订推理帧（高频，仅当前打开的会话）。理由：一个 Agent 可能有几十个会话，把全部推理帧推给每个观察者是浪费 |
| **D9** | **本地/远程统一程度** | **统一事件契约、双传输**：前端消费同一套事件模型，不管 Agent 是本地还是远程；但传输仍是两条（本地 ws/events、远程 relay）。**传输层合一不在本轮**（另一个量级的重构） |

### 仓库铁律

- **Repository 访问规范**（`pnpm check:repo`）：每个 Entity 有且仅有一个归属 Service。`Session` 唯一归属 `SessionService`，`Agent` 唯一归属 `AgentService`，`CloudAgent` 唯一归属 `CloudAgentService`。Controller / Gateway / Tool **禁止**直接注入 Repository——本 plan 中 `ImGateway` 取 Agent 只能经 `CloudAgentService.findActiveById`，新增的设备侧服务取 Session 只能经 `SessionService`。
- **`@Transactional()` 仅跨表写**（`pnpm check:tx`）：单表 upsert / 单表 update 不加。本 plan 新增的都是**内存路由表 + 事件发射**，不产生新的 DB 写入，因此**不应出现任何新的 `@Transactional`**。改动 `SessionService` 只是在**已有**方法里追加 emit，不改事务边界。
- **事务方法命名**（`pnpm check:naming`）：私有 `@Transactional()` 方法必须命中 `*InDb` / `*InTx` / `*InTransaction` / `persist*`；反向也成立。本 plan 不新增此类方法。
- **本地轨不用 `@WithLock`**：server-agent 是单进程 + SQLite + 单用户，没有 Redis 锁基础设施。并发保护用进程内数据结构（Map/Set）+ 同步的 check-then-act（在同一个 tick 内完成，不 await 跨越）。
- **`libs/types-*` 禁依赖 NestJS / TypeORM**：新事件常量文件只 import `zod` 和同包内的 schema。`libs/types` **不能反向依赖 `libs/types-agent`**——跨 relay 的 watch 帧 `event` 字段用 `z.string()` 透传事件名（与既有 `AgentRunFrame.event` 同构，见 `im.schema.ts:181-188` 的先例；`AgentRunAnswerItemSchema` 就地重定义也是同一先例）。
- **依赖方向**：`apps/server-*` → `libs/<domain>` → `libs/types-<domain>` → `libs/common`。只允许从上到下、从右到左。
- **用户可见串走 next-intl**（zh/en）：任何新增用户可见文案（如「已由其他端应答」「对端设备离线」）必须走 `useTranslations`，禁止裸字符串。改完跑 `pnpm sync:locales --write` 补 stub，终验要求 `pnpm sync:locales` 报 **missing=0**。
- **`@meshbot/web-common` 不碰 jotai / next-intl / apiClient / next-navigation**：共享包只放纯逻辑与受控组件，labels 由调用方注入。watch 的观察者核心逻辑（tracker 扩展、生命周期事件归并）放这里；socket 接线与 i18n 留在各 app。
- **前端表单**走 `Form/FormItem` + `useSchema`（本 plan 无表单）。
- **公开方法包含中文 JSDoc**；禁止在 `if` 前一行放注释（Biome 会破坏结构）。
- **数据库列名 snake_case**；本 plan **不新增任何表 / 列 / 迁移**（watch 状态全部是进程内内存，与 `agentRunRoutes` / `RemoteRunRegistryService` 同源）。
- **改 module / DI 必须真启动验证**：typecheck、单测、`pnpm check` 全都漏不掉 DI 崩溃。本 plan 新增 4 个 server-agent Provider + 改 `ImGateway` 构造参数，**每个引入新 Provider 的 Task 结尾必须跑 boot 验证**。
- **`pnpm test -- <path>` quirk**：root Jest 配置下 `pnpm test -- <path>` 的路径过滤会被 turbo 吞掉，跑单文件一律用 `npx jest <path>`。
- **`libs/agent` 用 vitest**，不强行统一（本轮不涉及）。
- **中文 conventional commit**，每个 Task 结尾一次 commit。

### ⚠️ 环境铁律（血的教训，违反会作废整轮验证）

- **boot 验证只用 `timeout 60 node dist/main.js`**，**绝不用 `MESHBOT_HOME=<临时目录> pnpm dev:server-agent`**。后者起 nodemon watcher：杀子进程没用，dist 一重建就重生幽灵进程抢占 7727 端口，已经害用户整轮验证作废。标准姿势：

  ```bash
  cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/server-agent build \
    && timeout 60 node apps/server-agent/dist/main.js 2>&1 | tail -40
  ```

- **跑完 web-agent build 要 `rm -rf apps/web-agent/.next`**——但**别删 `out`**，server-agent 同源伺服要它。
- **不起任何常驻进程**。需要观察运行时行为时用 `timeout` 包住，或写成一次性脚本跑完即退。
- **`pnpm check` 是 commit 前的硬门槛**，`pnpm check:strict` 是 CI 门槛。

### 泄漏防护（本设计最需防的点）

常驻转发器**没有「run 终止」这个天然终点**——`subscribeAndForward` 靠 `run.done` 退订，常驻版没有。四条防线，**每条各自要有独立测试步骤**：

1. **设备侧 idle 拆除**：观察者集合空后 5 分钟仍无新观察者 → 释放 EventEmitter2 监听（**T4** 设备侧 + **T10** 云端 idle 清扫）。
2. **观察者 socket 断开**：云端清其全部 watchId 并通知设备（**T10**）。
3. **设备 socket 断开**：云端清该设备全部 watch 路由并通知观察者（**T10**）。
4. **显式 unwatch**：客户端离开 Agent / 关闭会话主动发（**T8** 云端 + **T12** 客户端调用）。

### 跨任务类型一致（后续 Task 引用时一字不差）

- **事件名**（T1 定义，全 plan 引用）：`agent.watch.start` / `agent.watch.stop` / `agent.watch.forwarded` / `agent.watch.accepted` / `agent.watch.frame`；生命周期 `session.created` / `session.deleted` / `session.renamed` / `session.status_changed`。
- **watchId 寻址形状**（T1 定义）：下行帧复用 `AgentRunFrame`，`streamId` 与 `watchId` **二选一必填**（zod `refine`）。上行设备镜像帧是独立结构 `AgentWatchFrame`（无 watchId，带 `localAgentId` + 可选 `sessionId`）。
- **watchId 命名空间**：Agent 级与 Session 级**共用同一个命名空间、同一张 `watchRoutes` 表**，用 `scope: "agent" | "session"` 字段区分。同一客户端进入 Agent 拿一个 agent-scope watchId、打开会话再拿一个 session-scope watchId，**两个独立 id**。
- **云端三表结构**（**T8** 定义）：见 Architecture 图。
- **生命周期事件 payload**（T2 定义）：全部含 `agentId`（设备本地 Agent id）。
- **错误码**（T16 定义）：`HITL_ALREADY_ANSWERED = 3019`，message `"im.hitlAlreadyAnswered"`，httpStatus 409。

---

## 关键设计裁决（spec 未明确、本 plan 定，实施时不得偏离）

### 裁决 1：Agent 级与 Session 级 watch **共用一个 watchId 命名空间**

spec D8 说「两级 scope、同一套协议」，但没说 watchId 是否共用命名空间。本 plan 定：**共用**。

- 云端**一张主表** `watchRoutes: Map<watchId, WatchRoute>`，`scope` 字段区分两级；**两张反向索引表**分开（`agentWatchers` / `sessionWatchers`），因为 fan-out 的键结构不同。
- 客户端**每个 scope 各领一个独立 watchId**：进入 Agent 拿 `w-agent`，打开会话再拿 `w-session`，同一浏览器同时持有两个。
- **理由**：① 四条清理路径只需扫一张主表，`cleanupRoutes` 泛型直接复用，不必写两遍；② `AgentRunFrame.watchId` 单字段寻址无歧义，前端 tracker 一张表认领；③ `agent.watch.stop` 只带 watchId 就够，不必再带 scope。
- **代价**：一个客户端观察一个 Agent 的一个会话会占两条云端路由。可接受——watch 路由是纯内存 Map，量级是「在线观察者数 × 2」。

### 裁决 2：生命周期事件跨 relay 时**绝不复用本地事件名**，避免重复投递与镜像回环

这是本设计最容易出错、且出错后症状诡异（会话列表串台 / 事件无限回环）的地方。**三条防线，实施时逐条对照**：

**防线 1 —— 命名空间天然隔离（本地 vs 远程走不同事件名）**

| 路径 | 传输 | 事件名 | payload 里的 agentId |
|---|---|---|---|
| 本机 Agent 的会话变更 | `ws/events` 信封 | `session.created` 等**原名** | **本地** agentId |
| 远程 Agent 的会话变更（web-agent） | `ws/events` 信封 | `remote-agent.session_event`（**专属包裹**，T18） | **云端** agentId |
| 远程 Agent 的会话变更（web-main） | relay `agentRunFrame{watchId}` | 帧内 `event` 字段带原名，但**只有登记过该 watchId 的 tracker 才认领** | 云端 agentId |

三条路互不重叠，同一个浏览器上不可能对同一条会话收到两份。

**防线 2 —— A 侧代理绝不把远程帧重发成本地事件（T18 的硬约束）**

web-agent 的 server-agent 收到 Agent 级镜像帧后，**禁止** `emitter.emit(SESSION_LIFECYCLE_EVENTS.created, ...)`。否则同一进程内：
- `AgentWatchMirrorService` 会把「别人的事件」当本机事件再镜像出去 → **无限回环**；
- `EventsGateway` 会按本地路径下发 → 浏览器把远程会话**插进本机列表**。

必须包进 `REMOTE_AGENT_EVENTS.sessionEvent` 信封并携带云端 agentId。这与既有 `REMOTE_SHADOW_FRAME_EVENT` 不复用原始 `SESSION_WS_EVENTS.*` 名是**同一个理由**（见其 JSDoc：「复用会把 B 会话的数据污染进 A 本地 SQLite」）。T18 有一条专门的失败测试守这条线。

**防线 3 —— 推理帧的 D6 抑制（T11）**

推理帧存在真正的重复风险：同一客户端**既发起 run 又观察同一会话**时，设备侧对该会话同时跑着 per-run 转发器（回给发起方，走 streamId）与常驻转发器（镜像给观察者，走 watchId），发起方两条都收得到。`RemoteRunTracker` 按 D6 做**持有期整段抑制**——本实例持有该 sessionId 的活跃 stream 期间，watch 帧整条丢弃（不逐帧去重）。

**为什么设备侧不做去重**：设备不知道「哪个观察者恰好也是发起方」——`requesterDeviceId` 编码里 web-main 是 `user:<socketId>`，同一浏览器的两条通道 socketId 相同但云端是两条独立路由。判定信息只有客户端有，所以抑制放在客户端 tracker。

---

## 可中断交付点

- **完成 Task 12** → 「云端看本地实时输出」端到端可用（web-main 观察者直连 relay，推理帧实时 + inflight 续上）。**此处可停，独立交付验证。**
- **完成 Task 15** → 「A 远程建的会话，B 上实时出现」端到端可用（Agent 级生命周期镜像）。**此处可停，独立交付验证。**

---

## Task 1：watch 协议层（`libs/types`）

**Files:**
- `libs/types/src/im/im.events.ts`（改：`IM_WS_EVENTS` 新增 5 个事件名）
- `libs/types/src/im/watch.schema.ts`（新）
- `libs/types/src/im/watch.schema.spec.ts`（新）
- `libs/types/src/im/im.schema.ts`（改：`AgentRunFrame` 加可选 `watchId` + `streamId` 转可选 + 新增 `AgentRunFrameSchema`）
- `libs/types/src/im/agent-run.schema.spec.ts`（改：补 watchId 寻址断言）
- `libs/types/src/index.ts`（改：导出新符号）

**Interfaces:**

Produces（后续 Task 一字不差引用）：

```ts
// IM_WS_EVENTS 新增（client→server 上行 3 个，server→client 下行 2 个）
agentWatchStart: "agent.watch.start"        // 观察者 → 云端：发起 watch
agentWatchStop: "agent.watch.stop"          // 观察者 → 云端：显式 unwatch
agentWatchForwarded: "agent.watch.forwarded" // 云端 → 设备：转发 watch/unwatch 登记
agentWatchAccepted: "agent.watch.accepted"  // 设备 → 云端 → 观察者：受理回包（含 inflight）
agentWatchFrame: "agent.watch.frame"        // 设备 → 云端：镜像帧（云端 fan-out 成 AgentRunFrame）

// 类型
type WatchScope = "agent" | "session";
interface AgentWatchStartInput { watchId: string; targetAgentId: string; scope: WatchScope; sessionId?: string }
interface AgentWatchStopInput { watchId: string }
interface AgentWatchForwarded { watchId: string; localAgentId: string; scope: WatchScope; sessionId?: string; action: "start" | "stop"; requesterDeviceId: string }
interface AgentWatchAccepted { watchId: string; ok: boolean; reason?: "offline" | "cross_account" | "not_found" | "error"; inflight?: unknown }
interface AgentWatchFrame { localAgentId: string; scope: WatchScope; sessionId?: string; seq: number; event: string; payload: unknown }
interface AgentRunFrame { streamId?: string; watchId?: string; requesterDeviceId: string; seq: number; sessionId: string; event: string; payload: unknown }
```

Consumes：`libs/types/src/im/im.schema.ts` 既有 `AgentRunFrame`（`im.schema.ts:181`）。

### 步骤

- [ ] **写失败测试** `libs/types/src/im/watch.schema.spec.ts`：

```ts
import {
  AgentWatchStartSchema,
  AgentWatchStopSchema,
  AgentWatchFrameSchema,
  AgentWatchAcceptedSchema,
  AgentWatchForwardedSchema,
} from "./watch.schema";

describe("watch schema", () => {
  it("agent scope 不需要 sessionId", () => {
    const r = AgentWatchStartSchema.safeParse({
      watchId: "w1",
      targetAgentId: "cloud-a1",
      scope: "agent",
    });
    expect(r.success).toBe(true);
  });

  it("session scope 缺 sessionId 被拒", () => {
    const r = AgentWatchStartSchema.safeParse({
      watchId: "w1",
      targetAgentId: "cloud-a1",
      scope: "session",
    });
    expect(r.success).toBe(false);
  });

  it("session scope 带 sessionId 通过", () => {
    const r = AgentWatchStartSchema.safeParse({
      watchId: "w1",
      targetAgentId: "cloud-a1",
      scope: "session",
      sessionId: "s1",
    });
    expect(r.success).toBe(true);
  });

  it("watchId 空串被拒", () => {
    expect(
      AgentWatchStopSchema.safeParse({ watchId: "" }).success,
    ).toBe(false);
  });

  it("镜像帧带 localAgentId 与 seq", () => {
    const r = AgentWatchFrameSchema.safeParse({
      localAgentId: "local-a1",
      scope: "session",
      sessionId: "s1",
      seq: 1,
      event: "run.chunk",
      payload: { sessionId: "s1", delta: "hi" },
    });
    expect(r.success).toBe(true);
  });

  it("受理回包 ok=false 带 reason", () => {
    const r = AgentWatchAcceptedSchema.safeParse({
      watchId: "w1",
      ok: false,
      reason: "offline",
    });
    expect(r.success).toBe(true);
  });

  it("转发帧带 action 与 localAgentId", () => {
    const r = AgentWatchForwardedSchema.safeParse({
      watchId: "w1",
      localAgentId: "local-a1",
      scope: "agent",
      action: "start",
      requesterDeviceId: "user:sock-1",
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **跑挂**：`npx jest libs/types/src/im/watch.schema.spec.ts` → 期望 `Cannot find module './watch.schema'`。

- [ ] **最小实现** `libs/types/src/im/watch.schema.ts`：

```ts
import { z } from "zod";

/**
 * watch 粒度（spec D8）：
 * - `agent`：订该 Agent 的会话生命周期（新建/删除/改名/状态变化，低频）
 * - `session`：订某个会话的推理帧（`SESSION_WS_EVENTS.*` 全集，高频）
 *
 * 两级共用同一套协议与同一个 watchId 命名空间（云端 `watchRoutes` 一张表，
 * 靠本字段区分）；同一客户端进入 Agent 拿一个 agent-scope watchId、打开会话
 * 再拿一个 session-scope watchId，是**两个独立 id**。
 */
export const WatchScopeSchema = z.enum(["agent", "session"]);
export type WatchScope = z.infer<typeof WatchScopeSchema>;

/**
 * 观察者 → 云端：发起 watch（上行，需服务端鉴权）。
 * watchId 由客户端生成（雪花/uuid），云端只做唯一键用途不解析语义。
 * `scope:"session"` 时 sessionId 必填——Session 级 watch 精确到一个会话，
 * 缺 sessionId 云端无法建 `sessionWatchers` 索引。
 */
export const AgentWatchStartSchema = z
  .object({
    watchId: z.string().min(1),
    /** 目标云端 Agent id（同 `AgentRunStartSchema.targetAgentId`）。 */
    targetAgentId: z.string().min(1),
    scope: WatchScopeSchema,
    /** scope="session" 时必填：被观察会话在目标设备上的 id。 */
    sessionId: z.string().min(1).optional(),
  })
  .refine((v) => v.scope !== "session" || !!v.sessionId, {
    message: "scope=session 必须携带 sessionId",
    path: ["sessionId"],
  });
export type AgentWatchStartInput = z.infer<typeof AgentWatchStartSchema>;

/** 观察者 → 云端：显式 unwatch（离开 Agent / 关闭会话）。 */
export const AgentWatchStopSchema = z.object({
  watchId: z.string().min(1),
});
export type AgentWatchStopInput = z.infer<typeof AgentWatchStopSchema>;

/**
 * 云端 → 设备：转发 watch 登记 / 注销。
 * `localAgentId` 是云端按 targetAgentId 查 CloudAgent 表解出的目标设备本地
 * Agent id——设备只认自己的本地 id，绝不认云端 id（同 `AgentRunStartForwarded`）。
 * `requesterDeviceId` 编码同 `AgentRunStartForwarded`：device 为 deviceId，
 * 浏览器 user 为 `"user:" + socketId`，设备端原样回填不解析。
 */
export const AgentWatchForwardedSchema = z.object({
  watchId: z.string().min(1),
  localAgentId: z.string().min(1),
  scope: WatchScopeSchema,
  sessionId: z.string().min(1).optional(),
  action: z.enum(["start", "stop"]),
  requesterDeviceId: z.string().min(1),
});
export type AgentWatchForwarded = z.infer<typeof AgentWatchForwardedSchema>;

/**
 * 设备 → 云端 → 观察者：watch 受理回包。
 * `scope:"session"` 且 ok 时携带 `inflight` 快照（spec D7），观察者据此渲染
 * 半截输出续上正在跑的 run。形状是 server-agent 的 `InflightView`——`libs/types`
 * 不能反向依赖 `libs/types-agent`，故此处按 `unknown` 透传，观察者侧断言
 * （同 `DeviceQueryResponse.data` 的既有做法，见 `im.schema.ts:115-121`）。
 */
export const AgentWatchAcceptedSchema = z.object({
  watchId: z.string().min(1),
  ok: z.boolean(),
  reason: z.enum(["offline", "cross_account", "not_found", "error"]).optional(),
  inflight: z.unknown().optional(),
});
export type AgentWatchAccepted = z.infer<typeof AgentWatchAcceptedSchema>;

/**
 * 设备 → 云端：镜像帧（**每个 agent / 每个 session 只发一份**，云端按
 * `agentWatchers` / `sessionWatchers` 索引表 fan-out 成一份份带 watchId 的
 * `AgentRunFrame` 下发各观察者，见 spec §C 取舍）。
 *
 * 故本结构**不带 watchId**——设备发帧时不知道有几个观察者，也不该知道。
 * `event` 用 `z.string()` 透传事件名（`SESSION_WS_EVENTS.*` 或
 * `session.created` 等生命周期事件常量值）：`libs/types` 禁止反向依赖
 * `libs/types-agent`，与既有 `AgentRunFrame.event` 同构。
 */
export const AgentWatchFrameSchema = z.object({
  localAgentId: z.string().min(1),
  scope: WatchScopeSchema,
  /** scope="session" 时为该会话 id；scope="agent" 的生命周期帧可缺省。 */
  sessionId: z.string().min(1).optional(),
  seq: z.number().int().nonnegative(),
  event: z.string().min(1),
  payload: z.unknown(),
});
export type AgentWatchFrame = z.infer<typeof AgentWatchFrameSchema>;
```

- [ ] **跑过**：`npx jest libs/types/src/im/watch.schema.spec.ts` → 7 passed。

- [ ] **写失败测试**（`AgentRunFrame` watchId 寻址）——追加到 `libs/types/src/im/agent-run.schema.spec.ts`：

```ts
import { AgentRunFrameSchema } from "./im.schema";

describe("AgentRunFrame 双寻址", () => {
  const base = { requesterDeviceId: "dev-a", seq: 1, sessionId: "s1", event: "run.chunk", payload: {} };

  it("只带 streamId 通过（自己发起的流）", () => {
    expect(AgentRunFrameSchema.safeParse({ ...base, streamId: "st1" }).success).toBe(true);
  });

  it("只带 watchId 通过（观察的流）", () => {
    expect(AgentRunFrameSchema.safeParse({ ...base, watchId: "w1" }).success).toBe(true);
  });

  it("两个都不带被拒", () => {
    expect(AgentRunFrameSchema.safeParse(base).success).toBe(false);
  });

  it("两个都带被拒（寻址歧义）", () => {
    expect(
      AgentRunFrameSchema.safeParse({ ...base, streamId: "st1", watchId: "w1" }).success,
    ).toBe(false);
  });
});
```

- [ ] **跑挂**：`npx jest libs/types/src/im/agent-run.schema.spec.ts` → 期望 `AgentRunFrameSchema is not exported`。

- [ ] **最小实现**——改 `libs/types/src/im/im.schema.ts`，把 `AgentRunFrame` 从裸 interface 换成 zod + 推导类型：

```ts
/**
 * L3:B→A 运行帧（透传 `SESSION_WS_EVENTS.*` payload；event 用其常量字符串）。
 *
 * **双寻址（Agent 级观察通道）**：`streamId` 与 `watchId` **二选一必填**：
 * - `streamId`：接收方自己发起的远程 run 流（既有语义，不变）；
 * - `watchId`：接收方**观察**的流——云端按 `sessionWatchers` fan-out 时填入，
 *   设备侧上行的 `AgentWatchFrame` 本身不带 watchId（设备只发一份）。
 *
 * 两个都带 = 寻址歧义（前端 tracker 无法判定该走 streamId 还是 watchId 通道），
 * 两个都不带 = 无法路由，均判非法。
 *
 * requesterDeviceId 由 B 端原样回填 agentRunStart 收到的值，不解析（device 为
 * deviceId，浏览器 user 发起时为 `"user:" + socketId`）；watchId 寻址时由云端
 * fan-out 时填入登记的 requester 编码。
 */
export const AgentRunFrameSchema = z
  .object({
    streamId: z.string().min(1).optional(),
    watchId: z.string().min(1).optional(),
    requesterDeviceId: z.string(),
    seq: z.number().int().nonnegative(),
    sessionId: z.string(),
    event: z.string(),
    payload: z.unknown(),
  })
  .refine((v) => !!v.streamId !== !!v.watchId, {
    message: "streamId 与 watchId 二选一必填（不可同时缺省或同时提供）",
  });
export type AgentRunFrame = z.infer<typeof AgentRunFrameSchema>;
```

- [ ] **跑过**：`npx jest libs/types/src/im/agent-run.schema.spec.ts` → 全绿。

- [ ] **接线事件常量**——改 `libs/types/src/im/im.events.ts`，在 `IM_WS_EVENTS` 的 `agentRunEnd` 之后追加：

```ts
  /** Agent 级观察通道：观察者 → 云端，发起 watch（scope=agent 订生命周期 / scope=session 订推理帧）。 */
  agentWatchStart: "agent.watch.start",
  /** 观察者 → 云端，显式 unwatch（离开 Agent / 关闭会话）。 */
  agentWatchStop: "agent.watch.stop",
  /** 云端 → 设备，转发 watch 登记/注销（action: start | stop）。 */
  agentWatchForwarded: "agent.watch.forwarded",
  /** 设备 → 云端 → 观察者，watch 受理回包（session scope 携带 inflight 快照）。 */
  agentWatchAccepted: "agent.watch.accepted",
  /** 设备 → 云端，镜像帧（每 agent/session 只发一份，云端按 watchers 表 fan-out）。 */
  agentWatchFrame: "agent.watch.frame",
```

- [ ] **导出**——改 `libs/types/src/index.ts`，在 `im` 段落追加 `AgentRunFrameSchema`、`WatchScope`、`WatchScopeSchema`、`AgentWatchStartInput`、`AgentWatchStartSchema`、`AgentWatchStopInput`、`AgentWatchStopSchema`、`AgentWatchForwarded`、`AgentWatchForwardedSchema`、`AgentWatchAccepted`、`AgentWatchAcceptedSchema`、`AgentWatchFrame`、`AgentWatchFrameSchema`（`export * from "./im/watch.schema"` 亦可，按该文件既有风格逐项列出）。

- [ ] **全量校验**：

```bash
cd /Users/grant/Meta1/meshbot && pnpm typecheck 2>&1 | tail -20
```
期望：`Tasks: N successful`，无 TS 报错。**读完整输出，不要只看 tail 的退出码**——`AgentRunFrame` 从 interface 变 zod 推导类型后，`streamId` 变可选，既有构造点（`remote-run-inbound.service.ts:276`、`im.gateway.ts:571`、`remote-run.service.ts:168`、`remote-run-tracker.ts:73`）都要跟着适配。**本 Task 只把编译修通**（构造点显式传 `streamId`），行为零变化。

- [ ] **围栏**：`pnpm check:dead` → 新导出符号会被报为「无人引用」，本 Task 允许（后续 Task 消费）。若围栏 strict 挡住，把导出推迟到首个消费者 Task。

- [ ] **commit**：`feat(types): 新增 Agent 级观察通道 watch 协议（5 事件 + zod）与 AgentRunFrame 双寻址`

---

## Task 2：会话生命周期事件契约（`libs/types-agent`）

**Files:**
- `libs/types-agent/src/session-lifecycle.events.ts`（新）
- `libs/types-agent/src/session-lifecycle.events.spec.ts`（新）
- `libs/types-agent/src/session-status.events.ts`（改：`SessionStatusChangedEvent` 加 `agentId`）
- `libs/types-agent/src/index.ts`（改：导出）

**Interfaces:**

Produces（T4/T17/T18/T19 引用，一字不差）：

```ts
const SESSION_LIFECYCLE_EVENTS = {
  created: "session.created",
  deleted: "session.deleted",
  renamed: "session.renamed",
} as const;

interface SessionCreatedEvent { agentId: string; session: SessionSummary }
interface SessionDeletedEvent { agentId: string; sessionId: string }
interface SessionRenamedEvent { agentId: string; sessionId: string; title: string }
// 既有，本 Task 加 agentId：
interface SessionStatusChangedEvent { agentId: string; sessionId: string; status: SessionStatus }
```

Consumes：`libs/types-agent/src/session.ts` 的 `SessionSummarySchema` / `SessionStatus`。

### 步骤

- [ ] **写失败测试** `libs/types-agent/src/session-lifecycle.events.spec.ts`：

```ts
import {
  SESSION_LIFECYCLE_EVENTS,
  SessionCreatedEventSchema,
  SessionDeletedEventSchema,
  SessionRenamedEventSchema,
} from "./session-lifecycle.events";
import { SessionStatusChangedEventSchema } from "./session-status.events";

const summary = {
  id: "s1",
  title: "标题",
  status: "idle" as const,
  pinned: false,
  pinnedAt: null,
  titleGenerated: false,
  modelConfigId: null,
  agentId: "a1",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

describe("会话生命周期事件契约", () => {
  it("事件名与 spec 一致", () => {
    expect(SESSION_LIFECYCLE_EVENTS).toEqual({
      created: "session.created",
      deleted: "session.deleted",
      renamed: "session.renamed",
    });
  });

  it("created 携带 agentId 与完整 SessionSummary", () => {
    const r = SessionCreatedEventSchema.safeParse({ agentId: "a1", session: summary });
    expect(r.success).toBe(true);
  });

  it("created 缺 agentId 被拒（云端按 agentId fan-out，缺了无法路由）", () => {
    expect(SessionCreatedEventSchema.safeParse({ session: summary }).success).toBe(false);
  });

  it("deleted / renamed 形状", () => {
    expect(SessionDeletedEventSchema.safeParse({ agentId: "a1", sessionId: "s1" }).success).toBe(true);
    expect(
      SessionRenamedEventSchema.safeParse({ agentId: "a1", sessionId: "s1", title: "新名" }).success,
    ).toBe(true);
  });

  it("status_changed 纳入统一契约后必须带 agentId", () => {
    expect(
      SessionStatusChangedEventSchema.safeParse({ sessionId: "s1", status: "running" }).success,
    ).toBe(false);
    expect(
      SessionStatusChangedEventSchema.safeParse({
        agentId: "a1",
        sessionId: "s1",
        status: "running",
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **跑挂**：`npx jest libs/types-agent/src/session-lifecycle.events.spec.ts` → `Cannot find module './session-lifecycle.events'`。

- [ ] **最小实现** `libs/types-agent/src/session-lifecycle.events.ts`：

```ts
import { z } from "zod";
import { SessionSummarySchema } from "./session";

/**
 * server-agent 本地事件：会话生命周期（新建 / 删除 / 改名）。
 *
 * 与 `SESSION_STATUS_EVENTS.changed` 一起构成 spec §A 的「统一事件契约」——
 * 本地端经 `ws/events` 全局总线消费，远程观察者经 relay 的 Agent 级 watch
 * 镜像消费，**前端上层处理逻辑一份**（spec D9）。
 *
 * 发射点在 `SessionService`（`createSession` / `deleteSession` / `patch`）而非
 * Controller——这样 REST 改名、远程 run 建会话（`RemoteRunInboundService`）、
 * 定时任务建会话、`AgentService.removeWithData` 级联删会话等**所有**路径自动
 * 共享同一个事件，不会再出现某条路径静默不通知的洞（同 `AGENT_EVENTS.changed`
 * 把发射点下沉到 Service 的理由）。
 *
 * 每个 payload 都带 `agentId`：云端按 `${deviceId}:${localAgentId}` 键做
 * Agent 级 fan-out，缺了无法路由；前端也据此判定该事件属于哪个 Agent 的视图。
 */
export const SESSION_LIFECYCLE_EVENTS = {
  created: "session.created",
  deleted: "session.deleted",
  renamed: "session.renamed",
} as const;

/** 会话新建：携带完整 SessionSummary，观察者可直接插入列表无需回查。 */
export const SessionCreatedEventSchema = z.object({
  agentId: z.string(),
  session: SessionSummarySchema,
});
export type SessionCreatedEvent = z.infer<typeof SessionCreatedEventSchema>;

/** 会话删除：只带 id，观察者从列表移除。 */
export const SessionDeletedEventSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
});
export type SessionDeletedEvent = z.infer<typeof SessionDeletedEventSchema>;

/** 会话改名：手动改名与 LLM 自动生成标题两条路径共用。 */
export const SessionRenamedEventSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  title: z.string(),
});
export type SessionRenamedEvent = z.infer<typeof SessionRenamedEventSchema>;
```

- [ ] **改 `libs/types-agent/src/session-status.events.ts`** 加 `agentId`：

```ts
export const SessionStatusChangedEventSchema = z.object({
  /**
   * 会话归属的 Agent id。纳入统一生命周期契约（spec §A）后必填：云端按
   * `${deviceId}:${localAgentId}` 键做 Agent 级 fan-out，缺了无法路由到观察者。
   */
  agentId: z.string(),
  sessionId: z.string(),
  status: SessionStatus,
});
```

- [ ] **跑过**：`npx jest libs/types-agent/src/session-lifecycle.events.spec.ts` → 5 passed。

- [ ] **导出**——`libs/types-agent/src/index.ts` 追加 `export * from "./session-lifecycle.events";`（按该文件既有风格；若是逐项 re-export 则逐项列出 3 个常量 + 3 个 Schema + 3 个类型）。

- [ ] **修编译**：`SessionStatusChangedEvent` 加了必填 `agentId`，既有发射点 `apps/server-agent/src/services/runner.service.ts:136` 会 TS 报错。本 Task **只修编译**——`setSessionStatus` 内已能拿到 session（它写的就是 session 行），取 `session.agentId` 传入即可；若该处只有 sessionId，先经 `this.sessions.findOrNull(sessionId)` 取 agentId（真正的行为接线在 Task 17 统一处理，此处保证 `pnpm typecheck` 绿）。同步修 `events.gateway.ts:199-202` 与 `apps/web-agent/src/hooks/use-global-events.ts` 的类型引用（前端只读 `sessionId`/`status`，加字段不破坏）。

- [ ] **全量校验**：`pnpm typecheck 2>&1 | tail -20` → 无报错（**读完整输出**）。
- [ ] **回归**：`npx jest apps/server-agent/src/services/runner.service.spec.ts 2>&1 | tail -20` → 与改动前同样的通过数（若该 spec 断言了 status 事件 payload，同步补 `agentId`）。

- [ ] **commit**：`feat(types-agent): 新增会话生命周期事件契约（created/deleted/renamed）并给 status_changed 补 agentId`

---

## Task 3：抽取 `SessionFrameForwarder`（纯重构，行为零变化）

把 `RemoteRunInboundService.subscribeAndForward`（`remote-run-inbound.service.ts:227-300`）的转发内核抽成可复用类，让「per-run 转发器」与后续「常驻转发器」共用同一份 `allowedSessions` 动态集合 / seq / tool_call_end 剥 content / 终止判定逻辑——**spec §C2 明确要求「保留 subagent allowedSessions 动态集合逻辑，抽取时不能丢」**。

**Files:**
- `apps/server-agent/src/services/session-frame-forwarder.ts`（新）
- `apps/server-agent/src/services/session-frame-forwarder.spec.ts`（新）
- `apps/server-agent/src/services/remote-run-inbound.service.ts`（改：`subscribeAndForward` 改用新类）

**Interfaces:**

Produces（T4/T14 消费）：

```ts
interface ForwardedFrame { seq: number; sessionId: string; event: string; payload: unknown }
interface SessionFrameSink {
  onFrame(frame: ForwardedFrame): void;
  /** 主会话终止事件（run.done/error/interrupted）；`stopOnTerminal:true` 时调用后自动 stop()。 */
  onTerminal?(reason: "done" | "error" | "interrupted"): void;
}
class SessionFrameForwarder {
  constructor(emitter: EventEmitter2, sessionId: string, sink: SessionFrameSink, stopOnTerminal: boolean);
  start(): void;
  stop(): void;
  get active(): boolean;
}
const FORWARDED_SESSION_EVENTS: readonly string[]; // 从 remote-run-inbound 迁入
```

Consumes：`@nestjs/event-emitter` 的 `EventEmitter2`；`@meshbot/types-agent` 的 `SESSION_WS_EVENTS` / `RunSubagentSpawnedEvent` / `RunSubagentSettledEvent` / `RunToolCallEndEvent`。

**注意**：本类是**普通 class，不是 `@Injectable()` Provider**——每次订阅 new 一个实例，`EventEmitter2` 由调用方传入。不注入任何 Repository，`pnpm check:repo` 无影响。

### 步骤

- [ ] **写失败测试** `apps/server-agent/src/services/session-frame-forwarder.spec.ts`：

```ts
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SessionFrameForwarder, type ForwardedFrame } from "./session-frame-forwarder";

describe("SessionFrameForwarder", () => {
  let emitter: EventEmitter2;
  let frames: ForwardedFrame[];
  let terminals: string[];

  beforeEach(() => {
    emitter = new EventEmitter2();
    frames = [];
    terminals = [];
  });

  const sink = () => ({
    onFrame: (f: ForwardedFrame) => frames.push(f),
    onTerminal: (r: "done" | "error" | "interrupted") => terminals.push(r),
  });

  it("只转发目标 sessionId 的事件（防串台）", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), true);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "a" });
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "OTHER", delta: "b" });
    expect(frames.map((f) => f.sessionId)).toEqual(["s1"]);
    expect(frames[0].seq).toBe(1);
  });

  it("seq 从 1 递增", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), true);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "a" });
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "b" });
    expect(frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  it("subagent spawned 把子会话并入 allowedSessions，settled 移出", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), true);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "sub1", delta: "x" });
    expect(frames).toHaveLength(0); // 尚未并入

    emitter.emit(SESSION_WS_EVENTS.runSubagentSpawned, {
      sessionId: "s1",
      subSessionId: "sub1",
      toolCallId: "t1",
    });
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "sub1", delta: "y" });
    expect(frames.map((f) => f.sessionId)).toEqual(["s1", "sub1"]);

    emitter.emit(SESSION_WS_EVENTS.runSubagentSettled, {
      sessionId: "s1",
      subSessionId: "sub1",
      toolCallId: "t1",
    });
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "sub1", delta: "z" });
    expect(frames.map((f) => f.sessionId)).toEqual(["s1", "sub1", "s1"]);
  });

  it("run.tool_call_end 剥掉 content 字段", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), true);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runToolCallEnd, {
      sessionId: "s1",
      toolCallId: "t1",
      content: "巨大的文件内容",
      resultPreview: "预览",
    });
    expect(frames[0].payload).not.toHaveProperty("content");
    expect(frames[0].payload).toHaveProperty("resultPreview", "预览");
  });

  it("子会话终止事件不掐断主流", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), true);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runSubagentSpawned, {
      sessionId: "s1",
      subSessionId: "sub1",
      toolCallId: "t1",
    });
    emitter.emit(SESSION_WS_EVENTS.runDone, { sessionId: "sub1" });
    expect(terminals).toEqual([]);
    expect(fwd.active).toBe(true);
  });

  it("stopOnTerminal=true：主会话 run.done 后自动退订", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), true);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runDone, { sessionId: "s1" });
    expect(terminals).toEqual(["done"]);
    expect(fwd.active).toBe(false);
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "after" });
    expect(frames.filter((f) => f.event === SESSION_WS_EVENTS.runChunk)).toHaveLength(0);
  });

  it("stopOnTerminal=false（常驻）：run.done 后仍存活，跨多轮继续转发", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), false);
    fwd.start();
    emitter.emit(SESSION_WS_EVENTS.runDone, { sessionId: "s1" });
    expect(terminals).toEqual(["done"]);
    expect(fwd.active).toBe(true);

    // 第二轮：同一会话又开跑，帧仍然到达（这是常驻转发器与 per-run 的本质差异）
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "第二轮" });
    expect(frames.at(-1)).toMatchObject({ event: SESSION_WS_EVENTS.runChunk, sessionId: "s1" });
  });

  it("stop() 后不再有任何监听器残留", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), false);
    fwd.start();
    const before = emitter.listenerCount(SESSION_WS_EVENTS.runChunk);
    fwd.stop();
    expect(emitter.listenerCount(SESSION_WS_EVENTS.runChunk)).toBe(before - 1);
    expect(fwd.active).toBe(false);
  });

  it("stop() 幂等（重复调用不抛、不重复摘监听器）", () => {
    const fwd = new SessionFrameForwarder(emitter, "s1", sink(), false);
    fwd.start();
    fwd.stop();
    const after = emitter.listenerCount(SESSION_WS_EVENTS.runChunk);
    expect(() => fwd.stop()).not.toThrow();
    expect(emitter.listenerCount(SESSION_WS_EVENTS.runChunk)).toBe(after);
  });
});
```

- [ ] **跑挂**：`npx jest apps/server-agent/src/services/session-frame-forwarder.spec.ts` → `Cannot find module './session-frame-forwarder'`。

- [ ] **最小实现** `apps/server-agent/src/services/session-frame-forwarder.ts`（把 `remote-run-inbound.service.ts:29-69` 的两个常量 + `stripToolCallEndContent` 一并迁入）：

```ts
import {
  SESSION_WS_EVENTS,
  type RunSubagentSettledEvent,
  type RunSubagentSpawnedEvent,
  type RunToolCallEndEvent,
} from "@meshbot/types-agent";
import type { EventEmitter2 } from "@nestjs/event-emitter";

/**
 * 需要转发出设备的 `SESSION_WS_EVENTS.*` 全集（`session.subscribe` /
 * `unsubscribe` / `interrupt` 是客户端上行 socket 消息、`runSnapshot` 只在
 * 订阅时点对点补发，均不经 EventEmitter2 广播，转发这些名字永远收不到事件，
 * 故排除；其余 18 个由 RunnerService / ContextCompactor / DispatchSubagentService /
 * SessionTitleService 经 EventEmitter2 广播，逐个转发）。
 */
export const FORWARDED_SESSION_EVENTS: readonly string[] = [
  SESSION_WS_EVENTS.runHuman,
  SESSION_WS_EVENTS.runReasoning,
  SESSION_WS_EVENTS.runReasoningDone,
  SESSION_WS_EVENTS.runChunk,
  SESSION_WS_EVENTS.runDone,
  SESSION_WS_EVENTS.runInterrupted,
  SESSION_WS_EVENTS.runError,
  SESSION_WS_EVENTS.runUsage,
  SESSION_WS_EVENTS.runToolCallStart,
  SESSION_WS_EVENTS.runToolCallProgress,
  SESSION_WS_EVENTS.runToolCallArgsDelta,
  SESSION_WS_EVENTS.runToolCallEnd,
  SESSION_WS_EVENTS.runCompactionStart,
  SESSION_WS_EVENTS.runCompactionDone,
  SESSION_WS_EVENTS.runCompactionError,
  SESSION_WS_EVENTS.runSubagentSpawned,
  SESSION_WS_EVENTS.runSubagentSettled,
  SESSION_WS_EVENTS.titleUpdated,
];

/** 终止事件 → 终止原因映射。 */
const TERMINAL_REASON_BY_EVENT: ReadonlyMap<
  string,
  "done" | "error" | "interrupted"
> = new Map([
  [SESSION_WS_EVENTS.runDone, "done"],
  [SESSION_WS_EVENTS.runError, "error"],
  [SESSION_WS_EVENTS.runInterrupted, "interrupted"],
]);

/**
 * run.tool_call_end 转发前剥掉 `content` 字段（可能很大，如长文件读取结果）。
 * 与 `session.gateway.ts` 对本地前端的处理保持一致——前端只用 `resultPreview`
 * 渲染，`content` 没必要经 relay 跨设备中继一份，白白浪费带宽/体积。
 */
function stripToolCallEndContent(
  payload: RunToolCallEndEvent,
): Omit<RunToolCallEndEvent, "content"> {
  const { content: _content, ...rest } = payload;
  return rest;
}

/** 转发出去的一帧（调用方据此组 `AgentRunFrame` 或 `AgentWatchFrame`）。 */
export interface ForwardedFrame {
  seq: number;
  sessionId: string;
  event: string;
  payload: unknown;
}

/** 转发目的地。调用方实现，决定这些帧最终怎么发（streamId 寻址 / watch 镜像）。 */
export interface SessionFrameSink {
  onFrame(frame: ForwardedFrame): void;
  /**
   * 主会话终止（run.done / run.error / run.interrupted）。
   * 子会话（subagent）的终止事件**不**触发本回调——否则子代理一跑完整条流就断。
   */
  onTerminal?(reason: "done" | "error" | "interrupted"): void;
}

/**
 * 会话帧转发器：订阅某 sessionId 的 `SESSION_WS_EVENTS.*` 全集，按动态过滤
 * 集合 `allowedSessions` 过滤后交给 {@link SessionFrameSink}。
 *
 * 从 `RemoteRunInboundService.subscribeAndForward` 抽取（行为零变化），供两种
 * 生命周期共用：
 * - **per-run**（`stopOnTerminal=true`）：远程 run 的一次性转发，主会话终止即
 *   自动 `stop()`，与抽取前完全一致。
 * - **常驻**（`stopOnTerminal=false`）：Agent 级观察通道的 Session 级 watch，
 *   **不在 run 终止时退订**，跨多轮 run 存活到 unwatch / idle 拆除。这是常驻
 *   转发器与 per-run 的**本质差异**，也是本设计最需防的泄漏点——调用方必须
 *   自行保证 `stop()` 一定被调到（见 `SessionWatchService` 的 idle 拆除）。
 *
 * **allowedSessions 动态集合**：集合初始只含主 sessionId；收到
 * `runSubagentSpawned`（主会话事件，携带 `subSessionId`）→ 把子会话 id 并入，
 * 子会话的 runChunk 等过程事件才能进帧；收到 `runSubagentSettled` → 移出。
 * 这套逻辑在抽取中必须完整保留（spec §C2 明确点名）。
 *
 * 按动态 sessionId 集合精确过滤的理由：设备上可能有多个会话 / 多个 run 并行，
 * 同一事件名会被多个转发器各自的监听器收到，只有 `payload.sessionId` 命中本
 * 实例登记的集合才转发，防止跨会话串台。
 */
export class SessionFrameForwarder {
  private seq = 0;
  private readonly allowedSessions: Set<string>;
  private readonly registered: Array<{
    event: string;
    handler: (payload: unknown) => void;
  }> = [];
  private started = false;

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly sessionId: string,
    private readonly sink: SessionFrameSink,
    private readonly stopOnTerminal: boolean,
  ) {
    this.allowedSessions = new Set<string>([sessionId]);
  }

  /** 当前是否持有监听器（`start()` 后为 true，`stop()` 后为 false）。 */
  get active(): boolean {
    return this.started;
  }

  /** 挂上 `FORWARDED_SESSION_EVENTS` 全集的监听器。幂等（已启动则空操作）。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const event of FORWARDED_SESSION_EVENTS) {
      const handler = (payload: unknown): void => this.handle(event, payload);
      this.emitter.on(event, handler);
      this.registered.push({ event, handler });
    }
  }

  /** 摘除本实例登记的全部监听器。幂等（未启动 / 已停止均安全）。 */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const { event, handler } of this.registered) {
      this.emitter.off(event, handler);
    }
    this.registered.length = 0;
  }

  private handle(event: string, payload: unknown): void {
    const payloadSessionId = (payload as { sessionId?: unknown })?.sessionId;
    if (
      typeof payloadSessionId !== "string" ||
      !this.allowedSessions.has(payloadSessionId)
    ) {
      return; // 不在当前登记集合内的 session——防串台
    }

    if (event === SESSION_WS_EVENTS.runSubagentSpawned) {
      this.allowedSessions.add((payload as RunSubagentSpawnedEvent).subSessionId);
    } else if (event === SESSION_WS_EVENTS.runSubagentSettled) {
      this.allowedSessions.delete(
        (payload as RunSubagentSettledEvent).subSessionId,
      );
    }

    this.seq += 1;
    const wirePayload =
      event === SESSION_WS_EVENTS.runToolCallEnd
        ? stripToolCallEndContent(payload as RunToolCallEndEvent)
        : payload;
    this.sink.onFrame({
      seq: this.seq,
      sessionId: payloadSessionId,
      event,
      payload: wirePayload,
    });

    const reason = TERMINAL_REASON_BY_EVENT.get(event);
    if (reason && payloadSessionId === this.sessionId) {
      this.sink.onTerminal?.(reason);
      if (this.stopOnTerminal) this.stop();
    }
  }
}
```

- [ ] **跑过**：`npx jest apps/server-agent/src/services/session-frame-forwarder.spec.ts` → 9 passed。

- [ ] **改用新类**——`remote-run-inbound.service.ts`：删掉 `FORWARDED_SESSION_EVENTS`、`TERMINAL_REASON_BY_EVENT`、`stripToolCallEndContent` 三处本地定义与相关 import，`subscribeAndForward` 改为：

```ts
  /**
   * 订阅主 sessionId 的 `SESSION_WS_EVENTS.*` 全集，经 {@link SessionFrameForwarder}
   * 打包成 `AgentRunFrame` 经 relay 回发给发起设备（A）。转发内核（allowedSessions
   * 动态集合 / seq / tool_call_end 剥 content / 子会话终止不掐断主流）已抽到
   * `SessionFrameForwarder`，本方法只负责 relay 出口与注册表登记。
   *
   * `stopOnTerminal=true`：远程 run 是**一次性**的，主会话终止即回 `agentRunEnd`
   * 并自动退订（与 Agent 级观察通道的常驻转发器相反，后者跨多轮存活）。
   */
  private subscribeAndForward(
    cloudUserId: string,
    streamId: string,
    requesterDeviceId: string,
    sessionId: string,
  ): void {
    const forwarder = new SessionFrameForwarder(
      this.emitter,
      sessionId,
      {
        onFrame: (f) =>
          this.relay.emitAgentRunFrame(cloudUserId, {
            streamId,
            requesterDeviceId,
            seq: f.seq,
            sessionId: f.sessionId,
            event: f.event,
            payload: f.payload,
          } satisfies AgentRunFrame),
        onTerminal: (reason) => {
          this.relay.emitAgentRunEnd(cloudUserId, {
            streamId,
            requesterDeviceId,
            reason,
          } satisfies AgentRunEnd);
          this.registry.unbind(streamId);
        },
      },
      true,
    );
    forwarder.start();
    this.registry.bind(streamId, sessionId);
  }
```

- [ ] **回归（重构不变式）**：`npx jest apps/server-agent/src/services/remote-run-inbound.service.spec.ts 2>&1 | tail -30` → **与改动前完全相同的通过数，零新增失败**。若有失败，说明抽取丢了逻辑，回去补齐（不要改测试迁就实现）。

- [ ] **围栏**：`pnpm check:dead && pnpm check:repo 2>&1 | tail -20` → 通过。
- [ ] **commit**：`refactor(server-agent): 抽取 SessionFrameForwarder（保留 allowedSessions 动态集合），供常驻转发器复用`

---

## Task 4：设备侧会话级常驻转发器 `SessionWatchService`

修缺口 ①。spec §C2 的落点：按 `sessionId` 维护观察者集合，集合非空即挂常驻转发器；**不在 run 终止时退订**；集合空后 5 分钟 idle 拆除。

**Files:**
- `apps/server-agent/src/services/session-watch.service.ts`（新）
- `apps/server-agent/src/services/session-watch.service.spec.ts`（新）

**Interfaces:**

Produces（T6 / T16 消费）：

```ts
const WATCH_IDLE_MS = 5 * 60 * 1000;
@Injectable()
class SessionWatchService implements OnModuleDestroy {
  addWatcher(cloudUserId: string, localAgentId: string, sessionId: string, watchId: string): void;
  removeWatcher(watchId: string): void;
  /** watchId → 被观察 sessionId；未登记返 undefined（HITL watchId 寻址校验用，T16）。 */
  sessionIdOf(watchId: string): string | undefined;
  /** 该会话当前观察者数（测试与诊断用）。 */
  watcherCount(cloudUserId: string, sessionId: string): number;
  /** 是否仍持有该会话的常驻转发器（含 idle 宽限期内的空集合状态）。 */
  isForwarding(cloudUserId: string, sessionId: string): boolean;
  onModuleDestroy(): void;
}
```

Consumes：`SessionFrameForwarder`（T3）、`ImRelayClientService.emitAgentWatchFrame`（T5 新增；**T4 先按接口写，T5 补实现**——为避免顺序阻塞，T4 的 relay 依赖用最小接口 `{ emitAgentWatchFrame(cloudUserId, frame): void }` 声明，T5 让 `ImRelayClientService` 满足它）。

### 步骤

- [ ] **写失败测试** `apps/server-agent/src/services/session-watch.service.spec.ts`：

```ts
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import type { AgentWatchFrame } from "@meshbot/types";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SessionWatchService, WATCH_IDLE_MS } from "./session-watch.service";

describe("SessionWatchService（会话级常驻转发器）", () => {
  let emitter: EventEmitter2;
  let sent: Array<{ cloudUserId: string; frame: AgentWatchFrame }>;
  let svc: SessionWatchService;

  beforeEach(() => {
    jest.useFakeTimers();
    emitter = new EventEmitter2();
    sent = [];
    const relay = {
      emitAgentWatchFrame: (cloudUserId: string, frame: AgentWatchFrame) =>
        sent.push({ cloudUserId, frame }),
    };
    svc = new SessionWatchService(emitter, relay);
  });

  afterEach(() => {
    svc.onModuleDestroy();
    jest.useRealTimers();
  });

  it("首个观察者进入即挂监听并镜像帧", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "hi" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      cloudUserId: "u1",
      frame: {
        localAgentId: "agent-1",
        scope: "session",
        sessionId: "s1",
        seq: 1,
        event: SESSION_WS_EVENTS.runChunk,
        payload: { sessionId: "s1", delta: "hi" },
      },
    });
  });

  it("多观察者只镜像一份（云端负责 fan-out）", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    svc.addWatcher("u1", "agent-1", "s1", "w2");
    svc.addWatcher("u1", "agent-1", "s1", "w3");
    expect(svc.watcherCount("u1", "s1")).toBe(3);
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "hi" });
    expect(sent).toHaveLength(1);
  });

  it("跨多轮 run 存活（关键差异：run.done 不退订）", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    emitter.emit(SESSION_WS_EVENTS.runDone, { sessionId: "s1" });
    expect(svc.isForwarding("u1", "s1")).toBe(true);

    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "第二轮" });
    expect(sent.at(-1)?.frame.event).toBe(SESSION_WS_EVENTS.runChunk);
  });

  it("subagent allowedSessions 逻辑未丢", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    emitter.emit(SESSION_WS_EVENTS.runSubagentSpawned, {
      sessionId: "s1",
      subSessionId: "sub1",
      toolCallId: "t1",
    });
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "sub1", delta: "子" });
    expect(sent.map((s) => s.frame.sessionId)).toEqual(["s1", "sub1"]);
  });

  it("末个观察者离开后进入 idle 宽限，未到期不拆除", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    svc.removeWatcher("w1");
    expect(svc.watcherCount("u1", "s1")).toBe(0);
    expect(svc.isForwarding("u1", "s1")).toBe(true);

    jest.advanceTimersByTime(WATCH_IDLE_MS - 1);
    expect(svc.isForwarding("u1", "s1")).toBe(true);
  });

  it("idle 到期拆除监听（泄漏防线 1）", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    const before = emitter.listenerCount(SESSION_WS_EVENTS.runChunk);
    svc.removeWatcher("w1");
    jest.advanceTimersByTime(WATCH_IDLE_MS);
    expect(svc.isForwarding("u1", "s1")).toBe(false);
    expect(emitter.listenerCount(SESSION_WS_EVENTS.runChunk)).toBe(before - 1);
  });

  it("宽限期内新观察者进入 → 取消 idle 拆除，复用同一转发器", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    svc.removeWatcher("w1");
    jest.advanceTimersByTime(WATCH_IDLE_MS - 1000);
    svc.addWatcher("u1", "agent-1", "s1", "w2");
    jest.advanceTimersByTime(WATCH_IDLE_MS);
    expect(svc.isForwarding("u1", "s1")).toBe(true);
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "still" });
    expect(sent.at(-1)?.frame.event).toBe(SESSION_WS_EVENTS.runChunk);
  });

  it("sessionIdOf 支持 watchId 反查（HITL 寻址校验用）", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    expect(svc.sessionIdOf("w1")).toBe("s1");
    svc.removeWatcher("w1");
    expect(svc.sessionIdOf("w1")).toBeUndefined();
  });

  it("removeWatcher 未知 watchId 不抛", () => {
    expect(() => svc.removeWatcher("不存在")).not.toThrow();
  });

  it("不同账号同名 sessionId 互不干扰（账号隔离）", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    svc.addWatcher("u2", "agent-9", "s1", "w2");
    expect(svc.watcherCount("u1", "s1")).toBe(1);
    expect(svc.watcherCount("u2", "s1")).toBe(1);
  });

  it("onModuleDestroy 拆除全部转发器与定时器（进程退出不泄漏）", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    svc.addWatcher("u1", "agent-1", "s2", "w2");
    svc.onModuleDestroy();
    expect(svc.isForwarding("u1", "s1")).toBe(false);
    expect(svc.isForwarding("u1", "s2")).toBe(false);
    expect(emitter.listenerCount(SESSION_WS_EVENTS.runChunk)).toBe(0);
  });
});
```

- [ ] **跑挂**：`npx jest apps/server-agent/src/services/session-watch.service.spec.ts` → `Cannot find module './session-watch.service'`。

- [ ] **最小实现** `apps/server-agent/src/services/session-watch.service.ts`：

```ts
import type { AgentWatchFrame } from "@meshbot/types";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SessionFrameForwarder } from "./session-frame-forwarder";

/**
 * 观察者集合空后保留常驻转发器的宽限时长（spec D5：idle 5 分钟拆除）。
 * 留缓冲是为了避免用户刷新页面 / 切页时反复挂-退监听器（一次刷新就是一次
 * unwatch + 一次 watch，几百毫秒内往返）。
 */
export const WATCH_IDLE_MS = 5 * 60 * 1000;

/** relay 出口最小接口（`ImRelayClientService` 满足之；测试可注入伪实现）。 */
export interface WatchFrameRelay {
  emitAgentWatchFrame(cloudUserId: string, frame: AgentWatchFrame): void;
}

interface WatchEntry {
  cloudUserId: string;
  localAgentId: string;
  sessionId: string;
  forwarder: SessionFrameForwarder;
  watchers: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * 设备侧**会话级常驻转发器**注册表（spec §C2，修缺口 ①「对端发起的 run
 * 本端不实时输出」）。
 *
 * 与 `RemoteRunInboundService` 的 per-run 转发器（`SessionFrameForwarder`
 * `stopOnTerminal=true`）**本质差异**：本服务的转发器 `stopOnTerminal=false`，
 * **不在 run 终止时退订**，跨多轮 run 存活到 unwatch / idle 拆除——观察者中途
 * 打开会话后，对端第二轮、第三轮的输出照样实时到达。
 *
 * **设备只镜像一份**（spec §C 取舍）：同一 sessionId 有 N 个观察者时仍只有
 * **一个**转发器、只往 relay 发**一份** `AgentWatchFrame`，由云端按
 * `sessionWatchers` 索引表 fan-out 成 N 份带 watchId 的 `AgentRunFrame`。
 * 省设备上行带宽，且观察者增减完全不改变设备侧行为。
 *
 * **泄漏防护（本设计最需防的点）**：常驻转发器没有「run 终止」这个天然终点，
 * 靠三条防线兜底——① 本服务的 idle 拆除（观察者集合空后 {@link WATCH_IDLE_MS}
 * 仍无新观察者即 `stop()` 释放全部 EventEmitter2 监听器）；② 云端在观察者 /
 * 设备断线时下发 `action:"stop"` 触发 `removeWatcher`；③ `onModuleDestroy`
 * 进程退出兜底。
 *
 * **不用 `@WithLock`**：本地轨是单进程 + 单用户，没有 Redis 锁基础设施；
 * 所有 check-then-act 都在同一 tick 内同步完成（无 await 跨越），Node 单线程
 * 语义已保证原子。
 */
@Injectable()
export class SessionWatchService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionWatchService.name);
  /** `${cloudUserId}:${sessionId}` → 该会话的常驻转发器条目。 */
  private readonly entries = new Map<string, WatchEntry>();
  /** watchId → 条目键，供 `removeWatcher` / `sessionIdOf` 反查。 */
  private readonly watchIndex = new Map<string, string>();

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly relay: WatchFrameRelay,
  ) {}

  /** 条目键：账号隔离——不同账号可能有同名 sessionId（各自独立 SQLite）。 */
  private static key(cloudUserId: string, sessionId: string): string {
    return `${cloudUserId}:${sessionId}`;
  }

  /**
   * 登记一个 Session 级观察者。首个观察者进入时创建并启动常驻转发器；
   * 后续观察者只并入集合（不新建转发器，设备仍只镜像一份）。
   * 若该会话正处于 idle 宽限期，取消拆除定时器并复用既有转发器。
   */
  addWatcher(
    cloudUserId: string,
    localAgentId: string,
    sessionId: string,
    watchId: string,
  ): void {
    const key = SessionWatchService.key(cloudUserId, sessionId);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        cloudUserId,
        localAgentId,
        sessionId,
        watchers: new Set<string>(),
        idleTimer: null,
        forwarder: new SessionFrameForwarder(
          this.emitter,
          sessionId,
          {
            onFrame: (f) =>
              this.relay.emitAgentWatchFrame(cloudUserId, {
                localAgentId,
                scope: "session",
                sessionId: f.sessionId,
                seq: f.seq,
                event: f.event,
                payload: f.payload,
              }),
            // onTerminal 故意不实现：常驻转发器不在 run 终止时做任何事，
            // run.done 本身已作为普通帧镜像出去（观察者据此收尾 UI）。
          },
          false,
        ),
      };
      this.entries.set(key, entry);
      entry.forwarder.start();
      this.logger.debug(`会话观察通道建立（session=${sessionId}）`);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.watchers.add(watchId);
    this.watchIndex.set(watchId, key);
  }

  /**
   * 注销一个观察者。集合变空后**不立即拆除**，而是起 {@link WATCH_IDLE_MS}
   * 定时器；期间有新观察者进入则取消，到期仍无人则 `stop()` 释放监听器。
   */
  removeWatcher(watchId: string): void {
    const key = this.watchIndex.get(watchId);
    if (!key) return;
    this.watchIndex.delete(watchId);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.watchers.delete(watchId);
    if (entry.watchers.size > 0) return;
    const timer = setTimeout(() => {
      const cur = this.entries.get(key);
      if (!cur || cur.watchers.size > 0) return;
      cur.forwarder.stop();
      this.entries.delete(key);
      this.logger.debug(`会话观察通道 idle 拆除（session=${cur.sessionId}）`);
    }, WATCH_IDLE_MS);
    // unref 防止空闲定时器阻塞进程退出
    (timer as unknown as { unref?: () => void }).unref?.();
    entry.idleTimer = timer;
  }

  /** watchId → 被观察 sessionId；未登记返 undefined（HITL watchId 寻址校验用）。 */
  sessionIdOf(watchId: string): string | undefined {
    const key = this.watchIndex.get(watchId);
    if (!key) return undefined;
    return this.entries.get(key)?.sessionId;
  }

  /** 该会话当前观察者数（0 表示处于 idle 宽限期或未建立）。 */
  watcherCount(cloudUserId: string, sessionId: string): number {
    return (
      this.entries.get(SessionWatchService.key(cloudUserId, sessionId))?.watchers
        .size ?? 0
    );
  }

  /** 是否仍持有该会话的常驻转发器（含 idle 宽限期内的空集合状态）。 */
  isForwarding(cloudUserId: string, sessionId: string): boolean {
    return (
      this.entries.get(SessionWatchService.key(cloudUserId, sessionId))
        ?.forwarder.active === true
    );
  }

  /** 进程退出兜底：拆除全部转发器与定时器，杜绝监听器/定时器泄漏。 */
  onModuleDestroy(): void {
    for (const entry of this.entries.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.forwarder.stop();
    }
    this.entries.clear();
    this.watchIndex.clear();
  }
}
```

- [ ] **跑过**：`npx jest apps/server-agent/src/services/session-watch.service.spec.ts` → 11 passed。
- [ ] **围栏**：`pnpm check:repo && pnpm check:tx && pnpm check:naming 2>&1 | tail -10` → 通过（本服务不注入 Repository、无事务方法）。
- [ ] **commit**：`feat(server-agent): 新增 SessionWatchService 会话级常驻转发器（跨多轮存活 + idle 5 分钟拆除）`

---

## Task 5：relay 客户端 watch 收发接线

**Files:**
- `apps/server-agent/src/cloud/im-relay.events.ts`（改：新增 2 个桥事件 + 2 个负载接口）
- `apps/server-agent/src/cloud/im-relay-client.service.ts`（改：新增 2 个上行方法 + 1 个下行监听）
- `apps/server-agent/src/cloud/im-relay-client.service.spec.ts`（改：补 watch 收发断言）

**Interfaces:**

Produces：

```ts
// IM_RELAY_EVENTS 新增
agentWatchInbound: "im.relay.agent_watch"            // 云端转发的 watch 登记/注销（入站）
agentWatchFrameInbound: "im.relay.agent_watch_frame" // 云端回流的观察帧（A 侧作为观察者，T18 消费）
agentWatchAcceptedInbound: "im.relay.agent_watch_accepted" // 云端回流的受理回包（T18 消费）

interface ImRelayAgentWatchEvent { cloudUserId: string; forwarded: AgentWatchForwarded }

// ImRelayClientService 新增（`WatchFrameRelay` 由第 1 个方法满足）
emitAgentWatchFrame(cloudUserId: string, payload: AgentWatchFrame): void;      // best-effort
emitAgentWatchAccepted(cloudUserId: string, payload: AgentWatchAccepted): void; // best-effort
emitAgentWatchStart(cloudUserId: string, payload: AgentWatchStartInput): void;  // 抛 IM_NOT_CONNECTED
emitAgentWatchStop(cloudUserId: string, payload: AgentWatchStopInput): void;    // best-effort
```

Consumes：T1 的 `IM_WS_EVENTS.agentWatch*` 与 5 个 schema 类型。

### 步骤

- [ ] **写失败测试**——在 `im-relay-client.service.spec.ts` 追加（沿用该文件既有的 fake socket 工厂）：

```ts
  it("emitAgentWatchFrame 未连接时静默跳过（best-effort，不抛）", () => {
    expect(() =>
      svc.emitAgentWatchFrame("u-未连接", {
        localAgentId: "a1",
        scope: "session",
        sessionId: "s1",
        seq: 1,
        event: "run.chunk",
        payload: {},
      }),
    ).not.toThrow();
  });

  it("emitAgentWatchStart 未连接时抛 IM_NOT_CONNECTED", () => {
    expect(() =>
      svc.emitAgentWatchStart("u-未连接", {
        watchId: "w1",
        targetAgentId: "cloud-a1",
        scope: "agent",
      }),
    ).toThrow();
  });

  it("已连接时 watch 帧上行到 agent.watch.frame", async () => {
    await connectFake("u1");
    svc.emitAgentWatchFrame("u1", {
      localAgentId: "a1",
      scope: "session",
      sessionId: "s1",
      seq: 3,
      event: "run.chunk",
      payload: { sessionId: "s1" },
    });
    expect(fakeSocket.emitted).toContainEqual([
      IM_WS_EVENTS.agentWatchFrame,
      expect.objectContaining({ seq: 3, localAgentId: "a1" }),
    ]);
  });

  it("下行 agent.watch.forwarded 桥成 IM_RELAY_EVENTS.agentWatchInbound（含 cloudUserId）", async () => {
    await connectFake("u1");
    const seen: unknown[] = [];
    emitter.on(IM_RELAY_EVENTS.agentWatchInbound, (e) => seen.push(e));
    fakeSocket.fire(IM_WS_EVENTS.agentWatchForwarded, {
      watchId: "w1",
      localAgentId: "a1",
      scope: "session",
      sessionId: "s1",
      action: "start",
      requesterDeviceId: "user:sock-1",
    });
    expect(seen).toEqual([
      {
        cloudUserId: "u1",
        forwarded: expect.objectContaining({ watchId: "w1", action: "start" }),
      },
    ]);
  });
```

- [ ] **跑挂**：`npx jest apps/server-agent/src/cloud/im-relay-client.service.spec.ts` → 4 个新用例失败（方法不存在 / 事件未桥接）。

- [ ] **最小实现（1/2）**——`im-relay.events.ts` 追加：

```ts
  /** Agent 级观察通道：云端转发给本设备的 watch 登记/注销（观察者→云→本设备），供 AgentWatchInboundService 消费。 */
  agentWatchInbound: "im.relay.agent_watch",
  /** Agent 级观察通道：云端回流的观察帧（被观察设备→云→本设备作为观察者），供 web-agent 代理层消费。 */
  agentWatchFrameInbound: "im.relay.agent_watch_frame",
  /** Agent 级观察通道：云端回流的 watch 受理回包（含 inflight 快照），供 web-agent 代理层消费。 */
  agentWatchAcceptedInbound: "im.relay.agent_watch_accepted",
```

以及负载接口：

```ts
/**
 * Agent 级观察通道：入站 watch 登记/注销本地事件负载（云端转发，供本设备
 * `AgentWatchInboundService` 消费并驱动 `SessionWatchService` /
 * `AgentWatchMirrorService`）。
 */
export interface ImRelayAgentWatchEvent {
  cloudUserId: string;
  forwarded: AgentWatchForwarded;
}
```

- [ ] **最小实现（2/2）**——`im-relay-client.service.ts`：
  - 在 `socket.on(IM_WS_EVENTS.agentRunControl, ...)` 之后追加三条下行桥接：

```ts
      // Agent 级观察通道下行：入站 watch 登记/注销（云端转发到本设备，本设备是被观察方）。
      socket.on(
        IM_WS_EVENTS.agentWatchForwarded,
        (payload: AgentWatchForwarded) => {
          this.account.run(cloudUserId, () => {
            this.emitter.emit(IM_RELAY_EVENTS.agentWatchInbound, {
              cloudUserId,
              forwarded: payload,
            } satisfies ImRelayAgentWatchEvent);
          });
        },
      );
      // Agent 级观察通道下行：云端 fan-out 的观察帧（本设备是观察方，web-agent 代理路径）。
      socket.on(IM_WS_EVENTS.agentRunFrame, ...) // ← 既有监听器已覆盖 watchId 寻址的帧，不重复注册
      socket.on(
        IM_WS_EVENTS.agentWatchAccepted,
        (payload: AgentWatchAccepted) => {
          this.account.run(cloudUserId, () => {
            this.emitter.emit(IM_RELAY_EVENTS.agentWatchAcceptedInbound, payload);
          });
        },
      );
```

  > **注意**：云端 fan-out 下行用的是既有的 `IM_WS_EVENTS.agentRunFrame`（填 `watchId`、不填 `streamId`），**不新注册监听器**——既有的 `agentRunFrame` 监听器已经把帧桥成 `IM_RELAY_EVENTS.agentRunFrame`，T18 的代理层按 `frame.watchId` 是否存在分流即可。上面代码块里那一行注释就是提醒不要重复注册。`agentWatchFrameInbound` 常量保留给未来可能的独立通道，本轮**不使用**——若 `pnpm check:dead` 报未使用则删掉该常量，不要为围栏硬造消费者。

  - 在 `emitAgentRunEnd` 之后追加四个方法：

```ts
  /**
   * Agent 级观察通道：观察方发起 watch（上行，按账号）。
   * @throws {AppError} IM_NOT_CONNECTED — 该账号未建立连接时抛出。
   */
  emitAgentWatchStart(
    cloudUserId: string,
    payload: AgentWatchStartInput,
  ): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn?.socket.connected) {
      throw new AppError(AgentErrorCode.IM_NOT_CONNECTED);
    }
    conn.socket.emit(IM_WS_EVENTS.agentWatchStart, payload);
  }

  /**
   * Agent 级观察通道：观察方显式 unwatch（上行，按账号；best-effort——
   * 未连接时云端已因断线四路清理把该 watch 清掉，无需再抛）。
   */
  emitAgentWatchStop(cloudUserId: string, payload: AgentWatchStopInput): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn?.socket.connected) return;
    conn.socket.emit(IM_WS_EVENTS.agentWatchStop, payload);
  }

  /**
   * Agent 级观察通道：被观察设备回发镜像帧（上行，按账号；best-effort，
   * 未连接静默跳过——观察者由自身重连重 watch 兜底）。
   * 每个 agent/session **只发一份**，云端按 watchers 表 fan-out。
   */
  emitAgentWatchFrame(cloudUserId: string, payload: AgentWatchFrame): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn?.socket.connected) return;
    conn.socket.emit(IM_WS_EVENTS.agentWatchFrame, payload);
  }

  /**
   * Agent 级观察通道：被观察设备回发 watch 受理回包（含 inflight 快照，
   * 上行，按账号；best-effort，理由同上）。
   */
  emitAgentWatchAccepted(
    cloudUserId: string,
    payload: AgentWatchAccepted,
  ): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn?.socket.connected) return;
    conn.socket.emit(IM_WS_EVENTS.agentWatchAccepted, payload);
  }
```

- [ ] **跑过**：`npx jest apps/server-agent/src/cloud/im-relay-client.service.spec.ts 2>&1 | tail -20` → 全绿（含既有用例，**读完整输出确认零回归**）。
- [ ] **commit**：`feat(server-agent): relay 客户端接入 watch 协议（4 上行方法 + 2 下行桥事件）`

---

## Task 6：设备侧入站 watch 处理 `AgentWatchInboundService`

消费云端转发的 `agent.watch.forwarded`，驱动 `SessionWatchService`，并回发携带 inflight 快照的 `watch_accepted`（spec D7）。

**Files:**
- `apps/server-agent/src/services/agent-watch-inbound.service.ts`（新）
- `apps/server-agent/src/services/agent-watch-inbound.service.spec.ts`（新）

**Interfaces:**

Produces：

```ts
@Injectable()
class AgentWatchInboundService {
  @OnEvent(IM_RELAY_EVENTS.agentWatchInbound)
  onAgentWatch(evt: ImRelayAgentWatchEvent): Promise<void>;
}
```

Consumes：`SessionWatchService`（T4）、`RunnerService.getInflight(sessionId): InflightView | null`、`AgentService.findOrNull(localAgentId)`、`SessionService.findOrNull(sessionId)`、`AccountContextService.run`、`ImRelayClientService.emitAgentWatchAccepted`。

**门控（照抄 `RemoteRunInboundService` 的安全范式）**：只用 `forwarded.localAgentId`，绝不读云端下发的 targetAgentId；Agent 必须存在且 `remoteEnabled === true`；`scope:"session"` 时被观察会话必须存在且 `session.agentId === agent.id`（防拿任意 remote_enabled Agent 当跳板越权观察别的 Agent 的会话——**观察是读操作，但读的是别人的推理内容，越权同样致命**）。

### 步骤

- [ ] **写失败测试** `apps/server-agent/src/services/agent-watch-inbound.service.spec.ts`：

```ts
import { AgentWatchInboundService } from "./agent-watch-inbound.service";

describe("AgentWatchInboundService", () => {
  const mk = () => {
    const watches = { addWatcher: jest.fn(), removeWatcher: jest.fn() };
    const runner = { getInflight: jest.fn().mockReturnValue(null) };
    const agents = { findOrNull: jest.fn() };
    const sessions = { findOrNull: jest.fn() };
    const relay = { emitAgentWatchAccepted: jest.fn() };
    const account = { run: jest.fn((_: string, fn: () => unknown) => fn()) };
    const svc = new AgentWatchInboundService(
      watches as never,
      runner as never,
      agents as never,
      sessions as never,
      relay as never,
      account as never,
    );
    return { svc, watches, runner, agents, sessions, relay };
  };

  const startEvt = (over: Record<string, unknown> = {}) => ({
    cloudUserId: "u1",
    forwarded: {
      watchId: "w1",
      localAgentId: "a1",
      scope: "session" as const,
      sessionId: "s1",
      action: "start" as const,
      requesterDeviceId: "user:sock-1",
      ...over,
    },
  });

  it("Agent 未开远程 → 拒绝并回 ok:false", async () => {
    const { svc, agents, watches, relay } = mk();
    agents.findOrNull.mockResolvedValue({ id: "a1", remoteEnabled: false });
    await svc.onAgentWatch(startEvt() as never);
    expect(watches.addWatcher).not.toHaveBeenCalled();
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: false,
      reason: "not_found",
    });
  });

  it("Agent 查无 → 拒绝", async () => {
    const { svc, agents, watches } = mk();
    agents.findOrNull.mockResolvedValue(null);
    await svc.onAgentWatch(startEvt() as never);
    expect(watches.addWatcher).not.toHaveBeenCalled();
  });

  it("session scope：被观察会话不归该 Agent → 拒绝（防跳板越权观察）", async () => {
    const { svc, agents, sessions, watches, relay } = mk();
    agents.findOrNull.mockResolvedValue({ id: "a1", remoteEnabled: true });
    sessions.findOrNull.mockResolvedValue({ id: "s1", agentId: "别的Agent" });
    await svc.onAgentWatch(startEvt() as never);
    expect(watches.addWatcher).not.toHaveBeenCalled();
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: false,
      reason: "not_found",
    });
  });

  it("session scope 合法 → 登记观察者并回 inflight 快照（D7 中途续上）", async () => {
    const { svc, agents, sessions, runner, watches, relay } = mk();
    agents.findOrNull.mockResolvedValue({ id: "a1", remoteEnabled: true });
    sessions.findOrNull.mockResolvedValue({ id: "s1", agentId: "a1" });
    const inflight = {
      messageId: "m1",
      content: "半截",
      reasoning: "",
      reasoningStartedAt: null,
      toolCalls: [],
      status: "streaming",
    };
    runner.getInflight.mockReturnValue(inflight);
    await svc.onAgentWatch(startEvt() as never);
    expect(watches.addWatcher).toHaveBeenCalledWith("u1", "a1", "s1", "w1");
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: true,
      inflight,
    });
  });

  it("session scope 无活跃 run → inflight 为 null（不是报错）", async () => {
    const { svc, agents, sessions, runner, relay } = mk();
    agents.findOrNull.mockResolvedValue({ id: "a1", remoteEnabled: true });
    sessions.findOrNull.mockResolvedValue({ id: "s1", agentId: "a1" });
    runner.getInflight.mockReturnValue(null);
    await svc.onAgentWatch(startEvt() as never);
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: true,
      inflight: null,
    });
  });

  it("agent scope：不查会话、不带 inflight", async () => {
    const { svc, agents, sessions, watches, relay } = mk();
    agents.findOrNull.mockResolvedValue({ id: "a1", remoteEnabled: true });
    await svc.onAgentWatch(
      startEvt({ scope: "agent", sessionId: undefined }) as never,
    );
    expect(sessions.findOrNull).not.toHaveBeenCalled();
    expect(watches.addWatcher).not.toHaveBeenCalled(); // Agent 级不走 SessionWatchService
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: true,
      inflight: null,
    });
  });

  it("action:stop → 注销观察者，不回受理包", async () => {
    const { svc, watches, relay } = mk();
    await svc.onAgentWatch(startEvt({ action: "stop" }) as never);
    expect(watches.removeWatcher).toHaveBeenCalledWith("w1");
    expect(relay.emitAgentWatchAccepted).not.toHaveBeenCalled();
  });

  it("action:stop 不做鉴权查表（云端断线清理下发，必须无条件生效）", async () => {
    const { svc, agents } = mk();
    await svc.onAgentWatch(startEvt({ action: "stop" }) as never);
    expect(agents.findOrNull).not.toHaveBeenCalled();
  });

  it("内部异常 → 回 ok:false reason:error，不抛出（不炸 relay 监听器）", async () => {
    const { svc, agents, relay } = mk();
    agents.findOrNull.mockRejectedValue(new Error("boom"));
    await expect(svc.onAgentWatch(startEvt() as never)).resolves.toBeUndefined();
    expect(relay.emitAgentWatchAccepted).toHaveBeenCalledWith("u1", {
      watchId: "w1",
      ok: false,
      reason: "error",
    });
  });
});
```

- [ ] **跑挂**：`npx jest apps/server-agent/src/services/agent-watch-inbound.service.spec.ts` → 模块不存在。

- [ ] **最小实现** `apps/server-agent/src/services/agent-watch-inbound.service.ts`：

```ts
import { AccountContextService } from "@meshbot/lib-agent";
import type { AgentWatchAccepted } from "@meshbot/types";
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import {
  IM_RELAY_EVENTS,
  type ImRelayAgentWatchEvent,
} from "../cloud/im-relay.events";
import { AgentService } from "./agent.service";
import { RunnerService } from "./runner.service";
import { SessionService } from "./session.service";
import { SessionWatchService } from "./session-watch.service";

/**
 * 设备侧（被观察方）入站 watch 处理：消费云端转发的 `agent.watch.forwarded`，
 * 驱动 `SessionWatchService`（Session 级常驻转发器）与 Agent 级镜像器
 * （`AgentWatchMirrorService` 按 agentId 判断有无观察者，见 Task 14），
 * 并回发 `watch_accepted`。
 *
 * 【安全门控——照搬 `RemoteRunInboundService` 的二次门控范式】
 * `forwarded.localAgentId` 是网关按可信的 CloudAgent 表把云端 `targetAgentId`
 * 解出的本地 Agent id，**只用它、绝不读云端下发的 targetAgentId**。本地
 * `agents` 表的 `remote_enabled` 是唯一真相：Agent 必须存在且
 * `remoteEnabled === true` 才允许被观察——云端登记可能过期（设备离线期间用户
 * 关掉了远程开关）。
 *
 * 【session scope 的二次门控】被观察会话必须存在且 `session.agentId === agent.id`。
 * 观察虽是读操作，但读的是**别人 Agent 的完整推理过程**（reasoning、工具入参、
 * 文件内容预览），越权同样致命：若只校验 localAgentId 的 remoteEnabled，攻击者
 * 可拿账号里任意一个 `remote_enabled=true` 的「跳板」Agent X 当 localAgentId、
 * 配合任意 sessionId 观察归属 Agent Y（用户已关闭远程开关）的会话。相等校验把
 * 这条路堵死。
 *
 * 【`action:"stop"` 无条件生效，不做任何鉴权查表】stop 来源有三：观察者显式
 * unwatch、云端观察者断线清理、云端设备断线清理。后两条是**泄漏防线**，此时
 * Agent 可能已被删除 / 已关远程开关——若 stop 也走鉴权，恰恰在最需要清理的
 * 场景下清不掉，常驻转发器就永久泄漏了。stop 只按 watchId 注销，永不拒绝。
 */
@Injectable()
export class AgentWatchInboundService {
  private readonly logger = new Logger(AgentWatchInboundService.name);

  constructor(
    private readonly watches: SessionWatchService,
    private readonly runner: RunnerService,
    private readonly agents: AgentService,
    private readonly sessions: SessionService,
    private readonly relay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {}

  /** relay 收到云端转发的 agent.watch.forwarded（被观察设备侧入站）时触发。 */
  @OnEvent(IM_RELAY_EVENTS.agentWatchInbound)
  async onAgentWatch(evt: ImRelayAgentWatchEvent): Promise<void> {
    const { cloudUserId, forwarded } = evt;
    const { watchId, localAgentId, scope, sessionId, action } = forwarded;

    if (action === "stop") {
      // 无条件注销：三种来源（显式 unwatch / 观察者断线 / 设备断线）都必须生效。
      this.watches.removeWatcher(watchId);
      return;
    }

    const reject = (reason: AgentWatchAccepted["reason"]): void => {
      this.relay.emitAgentWatchAccepted(cloudUserId, {
        watchId,
        ok: false,
        reason,
      });
    };

    try {
      await this.account.run(cloudUserId, async () => {
        const agent = await this.agents.findOrNull(localAgentId);
        if (!agent?.remoteEnabled) {
          reject("not_found");
          return;
        }
        if (scope === "agent") {
          // Agent 级只订生命周期事件，不挂会话转发器、不带 inflight。
          // 镜像器（Task 14）按云端 watchers 表决定是否镜像，设备侧无需登记。
          this.relay.emitAgentWatchAccepted(cloudUserId, {
            watchId,
            ok: true,
            inflight: null,
          });
          return;
        }
        if (!sessionId) {
          reject("not_found");
          return;
        }
        const session = await this.sessions.findOrNull(sessionId);
        if (!session || session.agentId !== agent.id) {
          reject("not_found");
          return;
        }
        this.watches.addWatcher(cloudUserId, agent.id, sessionId, watchId);
        // D7 中途续上：把 runner 现成的 inflight 快照随受理包带回，观察者据此
        // 渲染半截输出（无活跃 run 时为 null，不是错误）。
        this.relay.emitAgentWatchAccepted(cloudUserId, {
          watchId,
          ok: true,
          inflight: this.runner.getInflight(sessionId),
        });
      });
    } catch (err) {
      this.logger.warn(
        `watch 处理失败（watchId=${watchId}, scope=${scope}）`,
        err instanceof Error ? err.stack : err,
      );
      reject("error");
    }
  }
}
```

- [ ] **跑过**：`npx jest apps/server-agent/src/services/agent-watch-inbound.service.spec.ts` → 9 passed。
- [ ] **commit**：`feat(server-agent): 新增 AgentWatchInboundService（二次门控 + inflight 快照受理）`

---

## Task 7：设备侧 module 接线 + boot 验证

**Files:**
- `apps/server-agent/src/app.module.ts` 或对应的 feature module（改：注册 2 个新 Provider）

**Interfaces:**

Consumes：`SessionWatchService`（T4）、`AgentWatchInboundService`（T6）。
Produces：可运行的 server-agent 进程。

### 步骤

- [ ] **定位注册点**：

```bash
grep -rn "RemoteRunInboundService\|RemoteRunControlService" apps/server-agent/src --include="*.module.ts"
```
把 `SessionWatchService` 与 `AgentWatchInboundService` 加到**同一个 module 的 providers**（它们与 `RemoteRunInboundService` 依赖面一致：`RunnerService` / `SessionService` / `AgentService` / `ImRelayClientService` / `AccountContextService` / `EventEmitter2` 都在同一 scope）。

- [ ] **`SessionWatchService` 的 relay 依赖**：构造签名是 `(emitter: EventEmitter2, relay: WatchFrameRelay)`，`WatchFrameRelay` 是接口不是 token，Nest 无法按接口注入。改为在 module 里用工厂 provider：

```ts
    {
      provide: SessionWatchService,
      useFactory: (emitter: EventEmitter2, relay: ImRelayClientService) =>
        new SessionWatchService(emitter, relay),
      inject: [EventEmitter2, ImRelayClientService],
    },
```

  或者更简单：把 `SessionWatchService` 构造第二参直接标注为 `ImRelayClientService` 类型（`WatchFrameRelay` 仅保留为文档性接口，测试传结构兼容的伪实现即可——TS 结构类型下 `{emitAgentWatchFrame}` 字面量赋给 `ImRelayClientService` 参数会报错，故测试里用 `as never`，与本 plan 其它 spec 的写法一致）。**二选一，实施者按当前 module 风格定；工厂方案更干净，优先。**

- [ ] **boot 验证（环境铁律）**：

```bash
cd /Users/grant/Meta1/meshbot && pnpm --filter @meshbot/server-agent build \
  && timeout 60 node apps/server-agent/dist/main.js 2>&1 | tail -40
```
期望输出包含 `Nest application successfully started`，**不含** `Nest can't resolve dependencies of ...`。**绝不用 `pnpm dev:server-agent`**（nodemon 幽灵进程抢 7727）。

- [ ] **全量单测**：`pnpm test 2>&1 | tail -30` → **读完整输出**，与本分支基线（`git stash` 后跑一次记下来的数字）对比，零新增失败。
- [ ] **围栏**：`pnpm check 2>&1 | tail -30` → 全绿。
- [ ] **commit**：`feat(server-agent): 注册 watch 通道 Provider 并通过 boot 验证`

---

## Task 8：云端 watch 路由三表 + 登记/注销

**Files:**
- `apps/server-main/src/ws/im.gateway.ts`（改：新增三张表 + 2 个 `@SubscribeMessage`）
- `apps/server-main/src/ws/im.gateway.spec.ts`（改：补 watch 登记/鉴权用例，复用既有 `makeGateway` 工厂）

**Interfaces:**

Produces（T9/T10 一字不差引用）：

```ts
interface WatchRoute {
  requester: RunRequester;                 // 既有类型，im.gateway.ts:57
  scope: WatchScope;                       // "agent" | "session"
  targetAgentId: string;                   // 云端 Agent id（寻址目标）
  localAgentId: string;                    // 解出的目标设备本地 Agent id
  targetDeviceId: string;                  // 宿主设备 id —— 泛型 cleanupRoutes 要求的字段名，勿改名
  sessionId?: string;                      // scope="session" 时存在
  userId: string;                          // 鉴权归属，HITL watchId 越权校验用（T16）
}

private readonly watchRoutes = new Map<string /* watchId */, WatchRoute>();
private readonly agentWatchers = new Map<string /* `${deviceId}:${localAgentId}` */, Set<string /* watchId */>>();
private readonly sessionWatchers = new Map<string /* `${deviceId}:${sessionId}` */, Set<string /* watchId */>>();
```

**索引键为什么用 `localAgentId` 而不是云端 `targetAgentId`**：设备回发的 `AgentWatchFrame` 里带的是它自己的 **localAgentId**（设备根本不知道云端 agent id）。fan-out 时要用「发送方 deviceId + 帧里的 localAgentId」去查索引，键必须同构。

Consumes：`CloudAgentService.findActiveById`、`DevicePresenceService.isOnline`、`IM_WS_EVENTS.agentWatch*`（T1）。

### 步骤

- [ ] **写失败测试**——追加到 `apps/server-main/src/ws/im.gateway.spec.ts`：

```ts
describe("Agent 级观察通道：watch 登记", () => {
  const client = (over: Record<string, unknown> = {}) =>
    ({ id: "sock-1", data: { user: { userId: "u1" }, orgId: "org-1" }, ...over }) as never;

  it("跨账号 watch 被拒（不下发设备、不登记）", async () => {
    const { gateway, agents, server } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1", userId: "别人", orgId: "org-1", deviceId: "dev-b", localAgentId: "local-a1",
        }),
      },
    });
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "agent" },
      client(),
    );
    expect(server.to).not.toHaveBeenCalledWith("device:dev-b");
    expect(gateway.watchRouteCount()).toBe(0);
  });

  it("设备离线 → 回 accepted{ok:false,reason:'offline'}，不登记（不静默）", async () => {
    const { gateway, server, emitted } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1", userId: "u1", orgId: "org-1", deviceId: "dev-b", localAgentId: "local-a1",
        }),
      },
      devicePresence: { isOnline: jest.fn().mockResolvedValue(false) },
    });
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "agent" },
      client(),
    );
    expect(emitted).toContainEqual([
      IM_WS_EVENTS.agentWatchAccepted,
      { watchId: "w1", ok: false, reason: "offline" },
    ]);
    expect(gateway.watchRouteCount()).toBe(0);
  });

  it("agent scope 合法 → 登记 watchRoutes + agentWatchers 并转发设备", async () => {
    const { gateway, server } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1", userId: "u1", orgId: "org-1", deviceId: "dev-b", localAgentId: "local-a1",
        }),
      },
    });
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "agent" },
      client(),
    );
    expect(gateway.watchRouteCount()).toBe(1);
    expect(gateway.agentWatcherIds("dev-b", "local-a1")).toEqual(["w1"]);
    expect(server.to).toHaveBeenCalledWith("device:dev-b");
    expect(server.emit).toHaveBeenCalledWith(IM_WS_EVENTS.agentWatchForwarded, {
      watchId: "w1",
      localAgentId: "local-a1",
      scope: "agent",
      sessionId: undefined,
      action: "start",
      requesterDeviceId: "user:sock-1",
    });
  });

  it("session scope 合法 → 登记到 sessionWatchers（不是 agentWatchers）", async () => {
    const { gateway } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1", userId: "u1", orgId: "org-1", deviceId: "dev-b", localAgentId: "local-a1",
        }),
      },
    });
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "session", sessionId: "s1" },
      client(),
    );
    expect(gateway.sessionWatcherIds("dev-b", "s1")).toEqual(["w1"]);
    expect(gateway.agentWatcherIds("dev-b", "local-a1")).toEqual([]);
  });

  it("多观察者登记到同一索引键（fan-out 前提）", async () => {
    const { gateway } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1", userId: "u1", orgId: "org-1", deviceId: "dev-b", localAgentId: "local-a1",
        }),
      },
    });
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "session", sessionId: "s1" },
      client({ id: "sock-1" }),
    );
    await gateway.handleAgentWatchStart(
      { watchId: "w2", targetAgentId: "cloud-a1", scope: "session", sessionId: "s1" },
      client({ id: "sock-2" }),
    );
    expect(gateway.sessionWatcherIds("dev-b", "s1").sort()).toEqual(["w1", "w2"]);
  });

  it("显式 unwatch → 三表一致清空并通知设备 stop（泄漏防线 4）", async () => {
    const { gateway, server } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1", userId: "u1", orgId: "org-1", deviceId: "dev-b", localAgentId: "local-a1",
        }),
      },
    });
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "session", sessionId: "s1" },
      client(),
    );
    gateway.handleAgentWatchStop({ watchId: "w1" }, client());
    expect(gateway.watchRouteCount()).toBe(0);
    expect(gateway.sessionWatcherIds("dev-b", "s1")).toEqual([]);
    expect(server.emit).toHaveBeenCalledWith(
      IM_WS_EVENTS.agentWatchForwarded,
      expect.objectContaining({ watchId: "w1", action: "stop" }),
    );
  });

  it("unwatch 他人的 watchId 被拒（越权，路由不动）", async () => {
    const { gateway } = makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1", userId: "u1", orgId: "org-1", deviceId: "dev-b", localAgentId: "local-a1",
        }),
      },
    });
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "session", sessionId: "s1" },
      client({ id: "sock-1" }),
    );
    gateway.handleAgentWatchStop({ watchId: "w1" }, client({ id: "别人的sock" }));
    expect(gateway.watchRouteCount()).toBe(1);
  });

  it("unwatch 未知 watchId 静默无操作（不抛）", () => {
    const { gateway } = makeGateway({});
    expect(() => gateway.handleAgentWatchStop({ watchId: "不存在" }, client())).not.toThrow();
  });
});
```

  > `makeGateway` 需要补返回 `emitted`（收集 `emitToRequester` 投递的 `[event, payload]`）与 `server.emit` 的 jest.Mock；按该文件既有 `server` 伪实现风格扩展即可。测试探针方法 `watchRouteCount()` / `agentWatcherIds()` / `sessionWatcherIds()` 是 gateway 上的**只读诊断方法**（非 `@SubscribeMessage`），实现里加。

- [ ] **跑挂**：`npx jest apps/server-main/src/ws/im.gateway.spec.ts 2>&1 | tail -20` → 新 describe 全红（方法不存在）。

- [ ] **最小实现**——`im.gateway.ts` 在 `queryRoutes` 声明之后追加三张表与类型：

```ts
  /**
   * Agent 级观察通道（spec §B）：watchId → 观察路由。
   *
   * 与 `agentRunRoutes`（streamId → **单个** requester 的 1:1）的关键差异：
   * watch 是 **1:N fan-out**——同一个会话/Agent 可能有多个观察者，故除主表外
   * 另有两张**反向索引表**（`agentWatchers` / `sessionWatchers`）。设备侧对
   * 每个 agent/session **只上行一份**镜像帧，由本网关按索引表扇出成一份份带
   * watchId 的 `AgentRunFrame`（spec §C 取舍：省设备上行，观察者增减不影响
   * 设备侧行为）。
   *
   * Agent 级与 Session 级**共用同一个 watchId 命名空间、同一张主表**，靠
   * `scope` 字段区分——清理路径（四条）因此只需维护这一张主表 + 两张索引，
   * 不必为两级各造一套。
   *
   * `targetDeviceId` 字段名**不可改**：泛型 `cleanupRoutes` 按
   * `{requester, targetDeviceId}` 读取面约束，改名会让本表用不上那套复用。
   *
   * 进程内 Map，server-main 多实例部署时需迁移到共享存储（同 agentRunRoutes /
   * queryRoutes 的既有限制）。
   */
  private readonly watchRoutes = new Map<string, WatchRoute>();

  /**
   * Agent 级 fan-out 反向索引：`${deviceId}:${localAgentId}` → watchId 集合。
   *
   * 键用**设备本地** agentId 而非云端 targetAgentId：设备回发的
   * `AgentWatchFrame.localAgentId` 是它自己的本地 id（设备根本不知道云端
   * agent id），fan-out 时按「发送方 deviceId + 帧里的 localAgentId」查表，
   * 键必须同构才查得到。
   */
  private readonly agentWatchers = new Map<string, Set<string>>();

  /** Session 级 fan-out 反向索引：`${deviceId}:${sessionId}` → watchId 集合。 */
  private readonly sessionWatchers = new Map<string, Set<string>>();
```

  类型定义放在文件顶部 `RunRequester` 之后：

```ts
/** Agent 级观察通道的一条观察路由（spec §B）。 */
interface WatchRoute {
  requester: RunRequester;
  scope: WatchScope;
  /** 寻址目标：云端 Agent id。 */
  targetAgentId: string;
  /** 由 targetAgentId 解出的目标设备本地 Agent id（转发给设备用）。 */
  localAgentId: string;
  /** 宿主设备 id。字段名受泛型 `cleanupRoutes` 的读取面约束，不可改名。 */
  targetDeviceId: string;
  /** scope="session" 时为被观察会话 id。 */
  sessionId?: string;
  /** 发起 watch 的用户 id（HITL watchId 寻址的越权校验用，见 Task 16）。 */
  userId: string;
}
```

  三张表的一致性维护收敛到两个私有方法（**T10 的四路清理全部复用 `unregisterWatch`，不要各自手写删表**）：

```ts
  /** 索引键：Agent 级。 */
  private static agentWatchKey(deviceId: string, localAgentId: string): string {
    return `${deviceId}:${localAgentId}`;
  }

  /** 索引键：Session 级。 */
  private static sessionWatchKey(deviceId: string, sessionId: string): string {
    return `${deviceId}:${sessionId}`;
  }

  /** 三表一致地登记一条 watch 路由（主表 + 对应 scope 的反向索引）。 */
  private registerWatch(watchId: string, route: WatchRoute): void {
    this.watchRoutes.set(watchId, route);
    const index =
      route.scope === "agent" ? this.agentWatchers : this.sessionWatchers;
    const key =
      route.scope === "agent"
        ? ImGateway.agentWatchKey(route.targetDeviceId, route.localAgentId)
        : ImGateway.sessionWatchKey(route.targetDeviceId, route.sessionId ?? "");
    let set = index.get(key);
    if (!set) {
      set = new Set<string>();
      index.set(key, set);
    }
    set.add(watchId);
  }

  /**
   * 三表一致地注销一条 watch 路由，并（可选）通知设备 stop。
   * **四条清理路径全部走这一个出口**（显式 unwatch / 观察者断线 / 设备断线 /
   * idle），杜绝「主表删了索引没删」的半清理泄漏。
   * @param notifyDevice 设备自身断线时为 false（设备已不在，通知无意义且会
   *                     往一个空房间发帧）。
   */
  private unregisterWatch(watchId: string, notifyDevice: boolean): void {
    const route = this.watchRoutes.get(watchId);
    if (!route) return;
    this.watchRoutes.delete(watchId);
    const index =
      route.scope === "agent" ? this.agentWatchers : this.sessionWatchers;
    const key =
      route.scope === "agent"
        ? ImGateway.agentWatchKey(route.targetDeviceId, route.localAgentId)
        : ImGateway.sessionWatchKey(route.targetDeviceId, route.sessionId ?? "");
    const set = index.get(key);
    if (set) {
      set.delete(watchId);
      if (set.size === 0) index.delete(key); // 空集合即删键，防 Map 无界增长
    }
    if (notifyDevice) {
      this.server
        .to(`device:${route.targetDeviceId}`)
        .emit(IM_WS_EVENTS.agentWatchForwarded, {
          watchId,
          localAgentId: route.localAgentId,
          scope: route.scope,
          sessionId: route.sessionId,
          action: "stop",
          requesterDeviceId: this.encodeRequester(route.requester),
        } satisfies AgentWatchForwarded);
    }
  }

  /** 诊断/测试探针：当前 watch 路由数。 */
  watchRouteCount(): number {
    return this.watchRoutes.size;
  }

  /** 诊断/测试探针：某设备某本地 Agent 的观察者 watchId 列表。 */
  agentWatcherIds(deviceId: string, localAgentId: string): string[] {
    return [
      ...(this.agentWatchers.get(ImGateway.agentWatchKey(deviceId, localAgentId)) ??
        []),
    ];
  }

  /** 诊断/测试探针：某设备某会话的观察者 watchId 列表。 */
  sessionWatcherIds(deviceId: string, sessionId: string): string[] {
    return [
      ...(this.sessionWatchers.get(
        ImGateway.sessionWatchKey(deviceId, sessionId),
      ) ?? []),
    ];
  }
```

  两个消息处理器：

```ts
  /**
   * Agent 级观察通道：观察者发起 watch → 鉴权（同账号 + 设备在线）→ 三表登记
   * → 定向下发到目标设备。
   *
   * 鉴权复用既有范式（同 `handleDeviceQueryRequest` / `handleAgentRunStart`）：
   * `CloudAgentService.findActiveById` + `agent.userId === requesterUserId`。
   * 跨账号**静默拒**（不回包，避免用 watchId 探测他人 Agent 是否存在）；设备
   * 离线**明确回包** `{ok:false, reason:"offline"}`（spec 错误处理：「设备离线 →
   * watch 送不达 → 云端回明确失败，观察者提示，不静默」）。
   */
  @SubscribeMessage(IM_WS_EVENTS.agentWatchStart)
  @UseGuards(WsAuthGuard)
  async handleAgentWatchStart(
    @MessageBody() body: AgentWatchStartInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const requesterUserId = (client.data.user as { userId?: string })?.userId;
    const requester = this.requesterOf(client);
    const agent = await this.agents.findActiveById(body.targetAgentId);
    if (!agent || agent.userId !== requesterUserId) return; // 静默拒（防探测）
    const online = await this.devicePresence.isOnline(
      agent.orgId ?? "",
      agent.deviceId,
    );
    if (!online) {
      this.emitToRequester(requester, IM_WS_EVENTS.agentWatchAccepted, {
        watchId: body.watchId,
        ok: false,
        reason: "offline",
      } satisfies AgentWatchAccepted);
      return;
    }
    this.registerWatch(body.watchId, {
      requester,
      scope: body.scope,
      targetAgentId: agent.id,
      localAgentId: agent.localAgentId,
      targetDeviceId: agent.deviceId,
      sessionId: body.sessionId,
      userId: requesterUserId as string,
    });
    this.server
      .to(`device:${agent.deviceId}`)
      .emit(IM_WS_EVENTS.agentWatchForwarded, {
        watchId: body.watchId,
        localAgentId: agent.localAgentId,
        scope: body.scope,
        sessionId: body.sessionId,
        action: "start",
        requesterDeviceId: this.encodeRequester(requester),
      } satisfies AgentWatchForwarded);
  }

  /**
   * Agent 级观察通道：观察者显式 unwatch（泄漏防线 4）。
   * 只有登记该 watchId 的 requester 本人能注销（`sameRequester` 全等校验），
   * 否则任意已认证连接都能拆别人的观察通道（DoS）。
   */
  @SubscribeMessage(IM_WS_EVENTS.agentWatchStop)
  @UseGuards(WsAuthGuard)
  handleAgentWatchStop(
    @MessageBody() body: AgentWatchStopInput,
    @ConnectedSocket() client: Socket,
  ): void {
    const route = this.watchRoutes.get(body.watchId);
    if (!route) return;
    if (!this.sameRequester(route.requester, this.requesterOf(client))) return;
    this.unregisterWatch(body.watchId, true);
  }
```

- [ ] **跑过**：`npx jest apps/server-main/src/ws/im.gateway.spec.ts 2>&1 | tail -20` → 全绿（含既有用例，**读完整输出**）。
- [ ] **commit**：`feat(server-main): 云端 watch 路由三表 + 登记/注销（鉴权复用 findActiveById 范式）`

---

## Task 9：云端 fan-out（镜像帧 + 受理回包）

**Files:**
- `apps/server-main/src/ws/im.gateway.ts`（改：新增 2 个 `@SubscribeMessage`）
- `apps/server-main/src/ws/im.gateway.spec.ts`（改：补 fan-out 用例）

**Interfaces:**

Produces：

```ts
@SubscribeMessage(IM_WS_EVENTS.agentWatchFrame)
handleAgentWatchFrame(body: AgentWatchFrame, client: Socket): void;
@SubscribeMessage(IM_WS_EVENTS.agentWatchAccepted)
handleAgentWatchAccepted(body: AgentWatchAccepted, client: Socket): void;
```

下行给观察者的帧形状（T11 的前端 tracker 一字不差消费）：

```ts
{ watchId, requesterDeviceId, seq, sessionId, event, payload }  // 无 streamId
```

Consumes：T8 的三表 + `unregisterWatch`。

### 步骤

- [ ] **写失败测试**——追加到 `im.gateway.spec.ts`：

```ts
describe("Agent 级观察通道：fan-out", () => {
  const deviceClient = () =>
    ({ id: "sock-dev", data: { user: { userId: "u1", deviceId: "dev-b" }, orgId: "org-1" } }) as never;
  const browserClient = (id: string) =>
    ({ id, data: { user: { userId: "u1" }, orgId: "org-1" } }) as never;

  const seed = async (gateway: never, scope: "agent" | "session") => {
    for (const [wid, sid] of [["w1", "sock-1"], ["w2", "sock-2"]] as const) {
      await (gateway as never as { handleAgentWatchStart: Function }).handleAgentWatchStart(
        { watchId: wid, targetAgentId: "cloud-a1", scope, sessionId: scope === "session" ? "s1" : undefined },
        browserClient(sid),
      );
    }
  };

  const mk = () =>
    makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1", userId: "u1", orgId: "org-1", deviceId: "dev-b", localAgentId: "local-a1",
        }),
      },
    });

  it("session scope：一份上行帧扇出给全部观察者，各带自己的 watchId", async () => {
    const { gateway, emitted } = mk();
    await seed(gateway as never, "session");
    gateway.handleAgentWatchFrame(
      { localAgentId: "local-a1", scope: "session", sessionId: "s1", seq: 7, event: "run.chunk", payload: { sessionId: "s1", delta: "x" } },
      deviceClient(),
    );
    const frames = emitted.filter(([e]) => e === IM_WS_EVENTS.agentRunFrame);
    expect(frames).toHaveLength(2);
    expect(frames.map(([, p]) => (p as { watchId: string }).watchId).sort()).toEqual(["w1", "w2"]);
    expect(frames[0][1]).toMatchObject({ seq: 7, sessionId: "s1", event: "run.chunk" });
    expect(frames[0][1]).not.toHaveProperty("streamId");
  });

  it("agent scope：生命周期帧按 agentWatchers 扇出", async () => {
    const { gateway, emitted } = mk();
    await seed(gateway as never, "agent");
    gateway.handleAgentWatchFrame(
      { localAgentId: "local-a1", scope: "agent", seq: 1, event: "session.created", payload: { agentId: "local-a1", session: { id: "s9" } } },
      deviceClient(),
    );
    expect(emitted.filter(([e]) => e === IM_WS_EVENTS.agentRunFrame)).toHaveLength(2);
  });

  it("非登记目标设备发帧 → 全部丢弃（防伪造注入）", async () => {
    const { gateway, emitted } = mk();
    await seed(gateway as never, "session");
    gateway.handleAgentWatchFrame(
      { localAgentId: "local-a1", scope: "session", sessionId: "s1", seq: 1, event: "run.chunk", payload: {} },
      { id: "sock-x", data: { user: { userId: "u1", deviceId: "别的设备" } } } as never,
    );
    expect(emitted.filter(([e]) => e === IM_WS_EVENTS.agentRunFrame)).toHaveLength(0);
  });

  it("无观察者时静默丢弃（不抛、不广播）", () => {
    const { gateway, emitted } = mk();
    expect(() =>
      gateway.handleAgentWatchFrame(
        { localAgentId: "local-a1", scope: "session", sessionId: "s1", seq: 1, event: "run.chunk", payload: {} },
        deviceClient(),
      ),
    ).not.toThrow();
    expect(emitted).toHaveLength(0);
  });

  it("受理回包按 watchId 定向回单个观察者（不是广播）", async () => {
    const { gateway, emitted } = mk();
    await seed(gateway as never, "session");
    gateway.handleAgentWatchAccepted(
      { watchId: "w1", ok: true, inflight: { content: "半截" } },
      deviceClient(),
    );
    const accepts = emitted.filter(([e]) => e === IM_WS_EVENTS.agentWatchAccepted);
    expect(accepts).toHaveLength(1);
    expect(accepts[0][1]).toMatchObject({ watchId: "w1", ok: true });
  });

  it("受理回包 ok:false → 转发观察者后立即注销该 watch（设备拒了就别留路由）", async () => {
    const { gateway } = mk();
    await seed(gateway as never, "session");
    gateway.handleAgentWatchAccepted({ watchId: "w1", ok: false, reason: "not_found" }, deviceClient());
    expect(gateway.sessionWatcherIds("dev-b", "s1")).toEqual(["w2"]);
    expect(gateway.watchRouteCount()).toBe(1);
  });

  it("非登记目标设备发受理包 → 丢弃", async () => {
    const { gateway, emitted } = mk();
    await seed(gateway as never, "session");
    gateway.handleAgentWatchAccepted(
      { watchId: "w1", ok: true },
      { id: "sock-x", data: { user: { userId: "u1", deviceId: "别的设备" } } } as never,
    );
    expect(emitted.filter(([e]) => e === IM_WS_EVENTS.agentWatchAccepted)).toHaveLength(0);
  });
});
```

- [ ] **跑挂**：`npx jest apps/server-main/src/ws/im.gateway.spec.ts` → 新 describe 全红。

- [ ] **最小实现**——`im.gateway.ts`：

```ts
  /**
   * Agent 级观察通道：被观察设备上行镜像帧 → 按反向索引 fan-out 给全部观察者。
   *
   * 设备**只上行一份**（不带 watchId，它不知道有几个观察者），本网关按
   * `${senderDeviceId}:${localAgentId}`（agent scope）或
   * `${senderDeviceId}:${sessionId}`（session scope）查索引，扇出成 N 份
   * **带 watchId、不带 streamId** 的 `AgentRunFrame`——前端 tracker 据此走
   * 「观察」通道而非「自己发起的流」通道。
   *
   * 索引键用**发送方连接的 deviceId**（`client.data.user.deviceId`）而非帧里
   * 任何字段：与 `handleAgentRunFrame` 的安全语义一致——任何已认证连接都能
   * 伪造帧体，只有连接层身份可信。伪造方查不到自己名下的索引键，帧被静默丢弃。
   */
  @SubscribeMessage(IM_WS_EVENTS.agentWatchFrame)
  @UseGuards(WsAuthGuard)
  handleAgentWatchFrame(
    @MessageBody() body: AgentWatchFrame,
    @ConnectedSocket() client: Socket,
  ): void {
    const senderDeviceId = (client.data.user as { deviceId?: string })?.deviceId;
    if (!senderDeviceId) return; // 非设备连接不得上行镜像帧
    const key =
      body.scope === "agent"
        ? ImGateway.agentWatchKey(senderDeviceId, body.localAgentId)
        : ImGateway.sessionWatchKey(senderDeviceId, body.sessionId ?? "");
    const index =
      body.scope === "agent" ? this.agentWatchers : this.sessionWatchers;
    const watchIds = index.get(key);
    if (!watchIds || watchIds.size === 0) return; // 无观察者，丢弃
    for (const watchId of watchIds) {
      const route = this.watchRoutes.get(watchId);
      if (!route) continue;
      this.emitToRequester(route.requester, IM_WS_EVENTS.agentRunFrame, {
        watchId,
        requesterDeviceId: this.encodeRequester(route.requester),
        seq: body.seq,
        sessionId: body.sessionId ?? "",
        event: body.event,
        payload: body.payload,
      } satisfies AgentRunFrame);
    }
  }

  /**
   * Agent 级观察通道：被观察设备回发受理包 → 按登记的 requester 定向回单个
   * 观察者（**不广播**：inflight 快照是该 watchId 独有的续上数据）。
   *
   * 发送方必须是登记的 targetDeviceId（同 `handleAgentRunFrame` 的防伪造语义）。
   * `ok:false` 时转发之后**立即注销该 watch**——设备已经明确拒绝（Agent 不可
   * 远程 / 会话不归它 / 内部错误），留着路由只会让后续帧扇给一个不存在的观察
   * 关系，属于泄漏。
   */
  @SubscribeMessage(IM_WS_EVENTS.agentWatchAccepted)
  @UseGuards(WsAuthGuard)
  handleAgentWatchAccepted(
    @MessageBody() body: AgentWatchAccepted,
    @ConnectedSocket() client: Socket,
  ): void {
    const route = this.watchRoutes.get(body.watchId);
    const senderDeviceId = (client.data.user as { deviceId?: string })?.deviceId;
    if (!route || senderDeviceId !== route.targetDeviceId) return;
    this.emitToRequester(route.requester, IM_WS_EVENTS.agentWatchAccepted, body);
    if (!body.ok) {
      // 设备拒了：转发后立即注销，不留悬挂路由（notifyDevice=false——设备
      // 自己就是拒绝方，再回一条 stop 是噪音）。
      this.unregisterWatch(body.watchId, false);
    }
  }
```

- [ ] **跑过**：`npx jest apps/server-main/src/ws/im.gateway.spec.ts 2>&1 | tail -20` → 全绿。
- [ ] **commit**：`feat(server-main): 云端 watch fan-out（一份上行扇出多观察者 + 受理回包定向回流）`

---

## Task 10：云端四路断线清理（泄漏防线 2/3/4）

spec 明确要求**四条断线清理路径各自单测**。第 4 条（显式 unwatch）已在 T8 落地并测过，本 Task 补前三条与 idle。

**Files:**
- `apps/server-main/src/ws/im.gateway.ts`（改：泛型 `cleanupRoutes` 加 `onRemoved` 回调 + `handleDisconnect` 接线 + idle 清扫）
- `apps/server-main/src/ws/im.gateway.spec.ts`（改：补四路清理用例）

**Interfaces:**

Produces：

```ts
// 既有泛型扩展（两个旧调用点不传第 4 参，行为完全不变）
private cleanupRoutes<T extends { requester: RunRequester; targetDeviceId: string }>(
  routes: Map<string, T>,
  client: Socket,
  deviceId: string | undefined,
  onRemoved?: (key: string, route: T) => void,
): void;

const WATCH_IDLE_MS = 5 * 60 * 1000;  // 与设备侧同值
```

Consumes：T8 的 `unregisterWatch`。

### 步骤

- [ ] **写失败测试**——追加到 `im.gateway.spec.ts`：

```ts
describe("Agent 级观察通道：四路清理（泄漏防护）", () => {
  const mk = () =>
    makeGateway({
      agents: {
        findActiveById: jest.fn().mockResolvedValue({
          id: "cloud-a1", userId: "u1", orgId: "org-1", deviceId: "dev-b", localAgentId: "local-a1",
        }),
      },
    });
  const browserClient = (id: string) =>
    ({ id, data: { user: { userId: "u1" }, orgId: "org-1" } }) as never;
  const deviceClient = () =>
    ({ id: "sock-dev", data: { user: { userId: "u1", deviceId: "dev-b" }, orgId: "org-1" } }) as never;

  it("路径①观察者 socket 断开 → 清其全部 watchId 并通知设备 stop", async () => {
    const { gateway, server } = mk();
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "agent" },
      browserClient("sock-1"),
    );
    await gateway.handleAgentWatchStart(
      { watchId: "w2", targetAgentId: "cloud-a1", scope: "session", sessionId: "s1" },
      browserClient("sock-1"),
    );
    await gateway.handleAgentWatchStart(
      { watchId: "w3", targetAgentId: "cloud-a1", scope: "session", sessionId: "s1" },
      browserClient("sock-别人"),
    );

    await gateway.handleDisconnect(browserClient("sock-1"));

    expect(gateway.watchRouteCount()).toBe(1);                    // 只剩别人的 w3
    expect(gateway.agentWatcherIds("dev-b", "local-a1")).toEqual([]); // 索引表同步清空
    expect(gateway.sessionWatcherIds("dev-b", "s1")).toEqual(["w3"]);
    const stops = (server.emit as jest.Mock).mock.calls.filter(
      ([e, p]) => e === IM_WS_EVENTS.agentWatchForwarded && p.action === "stop",
    );
    expect(stops.map(([, p]) => p.watchId).sort()).toEqual(["w1", "w2"]);
  });

  it("路径②设备 socket 断开 → 清该设备全部 watch 路由（不回发 stop：设备已不在）", async () => {
    const { gateway, server } = mk();
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "session", sessionId: "s1" },
      browserClient("sock-1"),
    );
    (server.emit as jest.Mock).mockClear();

    await gateway.handleDisconnect(deviceClient());

    expect(gateway.watchRouteCount()).toBe(0);
    expect(gateway.sessionWatcherIds("dev-b", "s1")).toEqual([]);
    const stops = (server.emit as jest.Mock).mock.calls.filter(
      ([e, p]) => e === IM_WS_EVENTS.agentWatchForwarded && p.action === "stop",
    );
    expect(stops).toHaveLength(0);
  });

  it("路径③显式 unwatch（T8 已覆盖，此处断言三表一致）", async () => {
    const { gateway } = mk();
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "session", sessionId: "s1" },
      browserClient("sock-1"),
    );
    gateway.handleAgentWatchStop({ watchId: "w1" }, browserClient("sock-1"));
    expect(gateway.watchRouteCount()).toBe(0);
    expect(gateway.sessionWatcherIds("dev-b", "s1")).toEqual([]);
  });

  it("路径④idle 清扫：超时未续期的 watch 被回收", async () => {
    jest.useFakeTimers();
    const { gateway } = mk();
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "session", sessionId: "s1" },
      browserClient("sock-1"),
    );
    jest.advanceTimersByTime(WATCH_IDLE_MS + 1000);
    gateway.sweepIdleWatches();
    expect(gateway.watchRouteCount()).toBe(0);
    jest.useRealTimers();
  });

  it("idle 清扫：有帧活动的 watch 被续期，不回收", async () => {
    jest.useFakeTimers();
    const { gateway } = mk();
    await gateway.handleAgentWatchStart(
      { watchId: "w1", targetAgentId: "cloud-a1", scope: "session", sessionId: "s1" },
      browserClient("sock-1"),
    );
    jest.advanceTimersByTime(WATCH_IDLE_MS - 1000);
    gateway.handleAgentWatchFrame(
      { localAgentId: "local-a1", scope: "session", sessionId: "s1", seq: 1, event: "run.chunk", payload: {} },
      deviceClient(),
    );
    jest.advanceTimersByTime(2000);
    gateway.sweepIdleWatches();
    expect(gateway.watchRouteCount()).toBe(1);
    jest.useRealTimers();
  });

  it("既有两表清理行为不因泛型扩展而改变（回归）", async () => {
    const { gateway } = mk();
    // agentRunRoutes / queryRoutes 的既有清理用例应仍全绿——本用例只作提醒，
    // 实际断言沿用该文件 describe("handleDisconnect") 下的既有用例，不重写。
    await gateway.handleDisconnect(browserClient("sock-未登记"));
    expect(gateway.watchRouteCount()).toBe(0);
  });
});
```

- [ ] **跑挂**：`npx jest apps/server-main/src/ws/im.gateway.spec.ts` → 新 describe 全红。

- [ ] **最小实现（1/3）**——扩展泛型 `cleanupRoutes`（`im.gateway.ts:209-236`），**只加第 4 个可选参数，两个旧调用点一字不改**：

```ts
  /**
   * 断连清理共用逻辑（`agentRunRoutes` / `queryRoutes` / `watchRoutes` 三表同构，
   * value 形状不同故用泛型约束到共有的 `{requester, targetDeviceId}` 读取面）：
   * - device 分支：按 deviceId 键，双向清理（该连接作为发起方或目标涉及的路由项都删）。
   * - user 分支：浏览器用户连接无 deviceId，断线即毁，仅按 client.id(socket.id) 清理其
   *   作为发起方的路由（user 连接不会是 targetDeviceId，无需对称清理 target 侧）。
   *
   * `onRemoved`（Agent 级观察通道新增）：主表删除某项时回调，供 `watchRoutes`
   * 同步清理两张反向索引表 + 通知设备 stop。**两个既有调用点不传此参，行为
   * 完全不变**——扩展而非改写，正是为了让 watch 复用这套判定，不新造第二份
   * 断线清理逻辑。
   */
  private cleanupRoutes<
    T extends { requester: RunRequester; targetDeviceId: string },
  >(
    routes: Map<string, T>,
    client: Socket,
    deviceId: string | undefined,
    onRemoved?: (key: string, route: T) => void,
  ): void {
    if (deviceId) {
      for (const [key, route] of routes) {
        if (
          (route.requester.kind === "device" &&
            route.requester.deviceId === deviceId) ||
          route.targetDeviceId === deviceId
        ) {
          routes.delete(key);
          onRemoved?.(key, route);
        }
      }
    } else {
      for (const [key, route] of routes) {
        if (
          route.requester.kind === "user" &&
          route.requester.socketId === client.id
        ) {
          routes.delete(key);
          onRemoved?.(key, route);
        }
      }
    }
  }
```

- [ ] **最小实现（2/3）**——`handleDisconnect`（`im.gateway.ts:350-351`）追加第三次调用：

```ts
      this.cleanupRoutes(this.agentRunRoutes, client, deviceId);
      this.cleanupRoutes(this.queryRoutes, client, deviceId);
      // Agent 级观察通道（泄漏防线 2/3）：常驻转发器没有「run 终止」这个天然
      // 终点，断线不清就永久泄漏。两条路径语义不同：
      // - 观察者断线（user 分支，deviceId 为 undefined）→ 必须通知设备 stop，
      //   否则设备侧的 SessionWatchService 要等满 5 分钟 idle 才拆。
      // - 设备断线（device 分支）→ 不通知（设备已不在，往空房间发帧无意义），
      //   观察者侧靠 relay 断开自行退化为「不实时」并在重连时重 watch。
      // 主表由 cleanupRoutes 删除，两张反向索引由 onRemoved 回调同步清理——
      // 走 removeWatchIndex 单一出口，杜绝「主表删了索引没删」的半清理泄漏。
      this.cleanupRoutes(this.watchRoutes, client, deviceId, (watchId, route) => {
        this.removeWatchIndex(watchId, route);
        if (!deviceId) this.notifyWatchStop(watchId, route);
      });
```

  把 `unregisterWatch` 拆成两个可独立调用的私有方法（`unregisterWatch` 保留为「删主表 + 调这两个」的门面，T8 的显式 unwatch 继续用它）：

```ts
  /** 只清两张反向索引（主表已由调用方删除时用，如 cleanupRoutes 的 onRemoved）。 */
  private removeWatchIndex(watchId: string, route: WatchRoute): void {
    const index =
      route.scope === "agent" ? this.agentWatchers : this.sessionWatchers;
    const key =
      route.scope === "agent"
        ? ImGateway.agentWatchKey(route.targetDeviceId, route.localAgentId)
        : ImGateway.sessionWatchKey(route.targetDeviceId, route.sessionId ?? "");
    const set = index.get(key);
    if (!set) return;
    set.delete(watchId);
    if (set.size === 0) index.delete(key);
  }

  /** 通知目标设备注销某 watch（观察者已走，设备侧该释放常驻转发器了）。 */
  private notifyWatchStop(watchId: string, route: WatchRoute): void {
    this.server
      .to(`device:${route.targetDeviceId}`)
      .emit(IM_WS_EVENTS.agentWatchForwarded, {
        watchId,
        localAgentId: route.localAgentId,
        scope: route.scope,
        sessionId: route.sessionId,
        action: "stop",
        requesterDeviceId: this.encodeRequester(route.requester),
      } satisfies AgentWatchForwarded);
  }
```

  `unregisterWatch` 改为：

```ts
  private unregisterWatch(watchId: string, notifyDevice: boolean): void {
    const route = this.watchRoutes.get(watchId);
    if (!route) return;
    this.watchRoutes.delete(watchId);
    this.removeWatchIndex(watchId, route);
    if (notifyDevice) this.notifyWatchStop(watchId, route);
  }
```

- [ ] **最小实现（3/3）**——idle 清扫。给 `WatchRoute` 加 `lastActiveAt: number` 字段（`registerWatch` 时 `Date.now()`，`handleAgentWatchFrame` fan-out 时续期），加一个可被测试直接调的清扫方法与定时器：

```ts
/** watch 路由的 idle 回收阈值（与设备侧 `WATCH_IDLE_MS` 同值，两侧独立各扫各的）。 */
const WATCH_IDLE_MS = 5 * 60 * 1000;
/** idle 清扫周期。 */
const WATCH_SWEEP_INTERVAL_MS = 60 * 1000;
```

```ts
  /**
   * idle 清扫（泄漏防线 4 的云端半边）：回收超过 {@link WATCH_IDLE_MS} 没有
   * 任何帧活动的 watch 路由。
   *
   * 为什么断线清理之外还要这一条：socket.io 的断线检测有窗口期，且存在
   * 「连接还活着但客户端早已导航离开、忘了发 unwatch」的场景（页面被后台
   * 挂起、JS 异常打断了 cleanup）。常驻转发器没有天然终点，多一层兜底。
   *
   * 公开方法而非私有：测试直接调它验证回收语义，不必等真实定时器。
   */
  sweepIdleWatches(): void {
    const now = Date.now();
    for (const [watchId, route] of this.watchRoutes) {
      if (now - route.lastActiveAt >= WATCH_IDLE_MS) {
        this.unregisterWatch(watchId, true);
      }
    }
  }
```

  定时器在 `afterInit`（或构造函数）里起，`unref` 防阻塞进程退出；`OnModuleDestroy` 清掉：

```ts
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  afterInit(): void {
    const timer = setInterval(() => this.sweepIdleWatches(), WATCH_SWEEP_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.sweepTimer = timer;
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
```

  > `BaseWebSocketGateway` 若已实现 `afterInit` / `OnModuleDestroy`，必须 `super.afterInit(...)` 调用父实现——**实施前先 `grep -n "afterInit\|OnModuleDestroy" libs/common/src/**/base-web-socket.gateway.ts` 确认**，漏调会破坏基类的宽限回收计时器。

  `handleAgentWatchFrame` 的 fan-out 循环里对每个命中的 route 续期：

```ts
      route.lastActiveAt = Date.now();
```

- [ ] **跑过**：`npx jest apps/server-main/src/ws/im.gateway.spec.ts 2>&1 | tail -30` → 全绿（**含既有 `handleDisconnect` 用例，读完整输出确认泛型扩展零回归**）。
- [ ] **boot 验证**：

```bash
pnpm --filter @meshbot/server-main build \
  && timeout 60 node apps/server-main/dist/main.js 2>&1 | tail -40
```
期望 `Nest application successfully started`（server-main 需 Postgres/Redis 可达；若本机无依赖，退化为确认 DI 解析阶段无 `Nest can't resolve dependencies`，连接失败可接受）。

- [ ] **围栏**：`pnpm check 2>&1 | tail -30` → 全绿。
- [ ] **commit**：`feat(server-main): watch 四路断线清理（泛型 cleanupRoutes 加 onRemoved + idle 清扫）`

---

## Task 11：web-common 观察者核心（tracker 扩展 + D6 抑制 + 序列器续上）

**Files:**
- `packages/web-common/src/session/transport.ts`（改：`FrameSequencer` 支持中途接入）
- `packages/web-common/src/session/remote-run-tracker.ts`（改：认 watchId + D6 抑制）
- `packages/web-common/src/session/remote-run-tracker.spec.ts`（新/改）
- `packages/web-common/src/session/watch-inflight.ts`（新：inflight → `run.snapshot` 事件合成）
- `packages/web-common/src/session/watch-inflight.spec.ts`（新）
- `packages/web-common/src/session/index.ts`（改：导出）

**Interfaces:**

Produces（T12/T19 消费）：

```ts
class FrameSequencer {
  constructor(opts?: { primeOnFirst?: boolean });  // 默认 false = 既有行为（从 seq 1 起）
}

class RemoteRunTracker {
  // 既有
  register(streamId: string, sessionId: string | null): void;
  owns(streamId: string): boolean;
  handleFrame(frame: AgentRunFrame): Array<{ event: string; payload: unknown }>;
  handleEnd(end: AgentRunEnd): { event: string; payload: unknown } | null;
  release(streamId: string): void;
  reset(): void;
  // 新增
  registerWatch(watchId: string, sessionId: string): void;
  releaseWatch(watchId: string): void;
  ownsWatch(watchId: string): boolean;
}

/** watch_accepted.inflight → 合成 run.snapshot 事件（D7 中途续上）；无活跃 run 返 null。 */
function inflightToSnapshotEvent(
  sessionId: string,
  inflight: unknown,
): { event: string; payload: RunSnapshotEvent } | null;
```

Consumes：T1 的 `AgentRunFrame`（带可选 `watchId`）。

**⚠️ 本 Task 修一个会让整条 watch 链路静默失效的坑**：`FrameSequencer` 硬编码 `nextExpectedSeq = 1`（`transport.ts:128`）。观察者中途接入时收到的第一帧 seq 可能是 47——现有实现会把它塞进 buffer 等一个永远不会来的 seq 1，**观察者一帧都吐不出来**。故 watch 流的 sequencer 必须「首帧定基准」。自己发起的 run 流保持从 1 起（默认参数不变，零行为变化）。

### 步骤

- [ ] **写失败测试（1/3）** `FrameSequencer` 中途接入——追加到 `packages/web-common/src/session/transport.spec.ts`（若无则新建）：

```ts
import { FrameSequencer } from "./transport";

describe("FrameSequencer primeOnFirst（观察者中途接入）", () => {
  it("默认从 seq 1 起（既有行为不变）", () => {
    const s = new FrameSequencer();
    expect(s.push({ seq: 47, event: "a", payload: 1 })).toEqual([]);
    expect(s.push({ seq: 1, event: "b", payload: 2 })).toEqual([
      { event: "b", payload: 2 },
    ]);
  });

  it("primeOnFirst：首帧 seq 即基准，立即吐出", () => {
    const s = new FrameSequencer({ primeOnFirst: true });
    expect(s.push({ seq: 47, event: "a", payload: 1 })).toEqual([
      { event: "a", payload: 1 },
    ]);
    expect(s.push({ seq: 48, event: "b", payload: 2 })).toEqual([
      { event: "b", payload: 2 },
    ]);
  });

  it("primeOnFirst：定基准后仍能重排乱序帧", () => {
    const s = new FrameSequencer({ primeOnFirst: true });
    s.push({ seq: 10, event: "a", payload: 1 });
    expect(s.push({ seq: 12, event: "c", payload: 3 })).toEqual([]);
    expect(s.push({ seq: 11, event: "b", payload: 2 })).toEqual([
      { event: "b", payload: 2 },
      { event: "c", payload: 3 },
    ]);
  });

  it("primeOnFirst：reset 后可重新定基准", () => {
    const s = new FrameSequencer({ primeOnFirst: true });
    s.push({ seq: 10, event: "a", payload: 1 });
    s.reset();
    expect(s.push({ seq: 99, event: "z", payload: 9 })).toEqual([
      { event: "z", payload: 9 },
    ]);
  });
});
```

- [ ] **跑挂**：`npx jest packages/web-common/src/session/transport.spec.ts` → primeOnFirst 三个用例红。

- [ ] **最小实现**——`transport.ts` 的 `FrameSequencer`：

```ts
export class FrameSequencer {
  private nextExpectedSeq = 1;
  private buffer = new Map<number, { event: string; payload: unknown }>();
  private primed: boolean;

  /**
   * @param opts.primeOnFirst 首帧的 seq 作为起始基准（**观察者通道必须开**）。
   *
   * 自己发起的 run 流总是从 seq 1 开始收，默认 false 即可。但**观察者是中途
   * 接入**——设备侧常驻转发器的 seq 从它建立那一刻起累加，观察者收到的第一
   * 帧可能是 seq 47。若仍按 1 起算，这帧会被塞进重排缓冲等一个永远不会到来的
   * seq 1，观察者一帧都吐不出来（静默失效，UI 表现为「watch 成功了但什么都
   * 不动」）。开启后首帧即定基准，之后正常按连续性重排。
   */
  constructor(opts?: { primeOnFirst?: boolean }) {
    this.primed = !opts?.primeOnFirst;
  }

  push(frame: {
    seq: number;
    event: string;
    payload: unknown;
  }): Array<{ event: string; payload: unknown }> {
    if (!this.primed) {
      this.primed = true;
      this.nextExpectedSeq = frame.seq;
    }
    // ...以下与既有实现完全一致（丢弃重复 / 缓冲乱序 / 连续吐出）
  }

  /** 重置序列器状态（清空缓冲和计数器；primeOnFirst 模式下允许重新定基准）。 */
  reset(): void {
    this.nextExpectedSeq = 1;
    this.buffer.clear();
    this.primed = this.primedDefault; // 构造时记住的初值
  }
}
```

  > 实现细节：把构造参数记到私有字段 `primedDefault`，`reset()` 恢复它。

- [ ] **跑过**：`npx jest packages/web-common/src/session/transport.spec.ts` → 全绿。

- [ ] **写失败测试（2/3）** tracker watch 支持 `packages/web-common/src/session/remote-run-tracker.spec.ts`：

```ts
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { RemoteRunTracker } from "./remote-run-tracker";

describe("RemoteRunTracker：watchId 通道", () => {
  const frame = (over: Record<string, unknown>) => ({
    requesterDeviceId: "d",
    seq: 1,
    sessionId: "s1",
    event: SESSION_WS_EVENTS.runChunk,
    payload: { sessionId: "s1", delta: "x" },
    ...over,
  }) as never;

  it("未登记的 watchId 帧被忽略（不是本实例观察的）", () => {
    const t = new RemoteRunTracker();
    expect(t.handleFrame(frame({ watchId: "未登记" }))).toEqual([]);
  });

  it("已登记的 watchId 帧被吐出（中途接入，seq 非 1 也能吐）", () => {
    const t = new RemoteRunTracker();
    t.registerWatch("w1", "s1");
    expect(t.handleFrame(frame({ watchId: "w1", seq: 47 }))).toEqual([
      { event: SESSION_WS_EVENTS.runChunk, payload: { sessionId: "s1", delta: "x" } },
    ]);
  });

  it("watch 通道跨多轮存活（run.done 后不自动注销）", () => {
    const t = new RemoteRunTracker();
    t.registerWatch("w1", "s1");
    t.handleFrame(frame({ watchId: "w1", seq: 1, event: SESSION_WS_EVENTS.runDone }));
    expect(t.ownsWatch("w1")).toBe(true);
    expect(
      t.handleFrame(frame({ watchId: "w1", seq: 2 })),
    ).toHaveLength(1);
  });

  it("releaseWatch 后不再吐帧", () => {
    const t = new RemoteRunTracker();
    t.registerWatch("w1", "s1");
    t.releaseWatch("w1");
    expect(t.ownsWatch("w1")).toBe(false);
    expect(t.handleFrame(frame({ watchId: "w1" }))).toEqual([]);
  });

  it("D6 抑制：同一客户端已持有该 session 的 stream 时，watch 帧被丢弃（不收双份）", () => {
    const t = new RemoteRunTracker();
    t.register("st1", "s1");    // 自己发起的 run
    t.registerWatch("w1", "s1"); // 同时也在观察同一会话
    expect(t.handleFrame(frame({ watchId: "w1" }))).toEqual([]);
    expect(t.handleFrame(frame({ streamId: "st1" }))).toHaveLength(1);
  });

  it("D6 抑制解除：自己的 stream 结束后 watch 帧恢复吐出", () => {
    const t = new RemoteRunTracker();
    t.register("st1", "s1");
    t.registerWatch("w1", "s1");
    t.handleEnd({ streamId: "st1", requesterDeviceId: "d", reason: "done" } as never);
    expect(t.handleFrame(frame({ watchId: "w1", seq: 5 }))).toHaveLength(1);
  });

  it("抑制只针对同一 sessionId，别的会话的 watch 帧不受影响", () => {
    const t = new RemoteRunTracker();
    t.register("st1", "s1");
    t.registerWatch("w2", "s2");
    expect(
      t.handleFrame(frame({ watchId: "w2", sessionId: "s2", payload: { sessionId: "s2" } })),
    ).toHaveLength(1);
  });

  it("reset 清空 stream 与 watch 两类登记", () => {
    const t = new RemoteRunTracker();
    t.register("st1", "s1");
    t.registerWatch("w1", "s2");
    t.reset();
    expect(t.owns("st1")).toBe(false);
    expect(t.ownsWatch("w1")).toBe(false);
  });

  it("既有 streamId 行为零变化（回归）", () => {
    const t = new RemoteRunTracker();
    t.register("st1", null);
    expect(t.handleFrame(frame({ streamId: "st1" }))).toHaveLength(1);
    expect(
      t.handleEnd({ streamId: "st1", requesterDeviceId: "d", reason: "done" } as never),
    ).toBeNull();
    expect(t.owns("st1")).toBe(false);
  });
});
```

- [ ] **跑挂**：`npx jest packages/web-common/src/session/remote-run-tracker.spec.ts`。

- [ ] **最小实现**——`remote-run-tracker.ts` 新增 watch 登记表与分流：

```ts
interface WatchEntry {
  sessionId: string;
  sequencer: FrameSequencer;
}

export class RemoteRunTracker {
  private readonly streams = new Map<string, StreamEntry>();
  /**
   * 本实例观察（watch）中的通道：watchId → 条目。与 `streams` 分表的理由——
   * 两者生命周期完全不同：stream 收到 `agentRunEnd` 即销毁（一次性），watch
   * **跨多轮 run 存活**到显式 `releaseWatch`（常驻），混在一张表里必然会被
   * `handleEnd` 的删除逻辑误清。
   */
  private readonly watches = new Map<string, WatchEntry>();

  /**
   * 登记一路观察通道（`watch_accepted{ok:true}` 到达后调用）。
   * sequencer 开 `primeOnFirst`——观察者是中途接入，首帧 seq 不是 1。
   */
  registerWatch(watchId: string, sessionId: string): void {
    this.watches.set(watchId, {
      sessionId,
      sequencer: new FrameSequencer({ primeOnFirst: true }),
    });
  }

  /** 注销一路观察通道（unwatch / 组件卸载）。 */
  releaseWatch(watchId: string): void {
    this.watches.delete(watchId);
  }

  /** 该 watchId 是否本实例登记（供调用方短路无需处理的事件）。 */
  ownsWatch(watchId: string): boolean {
    return this.watches.has(watchId);
  }

  /**
   * 处理一帧 `AgentRunFrame`。按 `streamId` / `watchId` 分流（协议保证二选一）：
   *
   * - `streamId`：本实例**自己发起**的远程 run（既有逻辑，零变化）。
   * - `watchId`：本实例**观察**的通道。此处实现 spec **D6 重复投递抑制**——
   *   若本实例同时持有**同一 sessionId** 的活跃 stream（自己刚发起的那轮），
   *   watch 帧整条丢弃：设备侧对同一会话既走 per-run 转发器（回给发起方）
   *   又走常驻转发器（镜像给观察者），发起方两条都收得到，不抑制就是双份。
   *   按「持有期整段抑制」而非逐帧去重（D6 明确取此策略，简单且无状态爆炸）。
   */
  handleFrame(
    frame: AgentRunFrame,
  ): Array<{ event: string; payload: unknown }> {
    if (frame.watchId) {
      const entry = this.watches.get(frame.watchId);
      if (!entry) return [];
      if (this.hasActiveStreamFor(entry.sessionId)) return []; // D6 抑制
      return entry.sequencer.push({
        seq: frame.seq,
        event: frame.event,
        payload: frame.payload,
      });
    }
    if (!frame.streamId) return [];
    // ...以下 streamId 分支与既有实现完全一致
  }

  /** 本实例是否持有该会话的活跃 stream（D6 抑制判定）。 */
  private hasActiveStreamFor(sessionId: string): boolean {
    for (const entry of this.streams.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  /** 清空全部登记（stream + watch），transport dispose 时调用。 */
  reset(): void {
    this.streams.clear();
    this.watches.clear();
  }
}
```

- [ ] **跑过**：`npx jest packages/web-common/src/session/remote-run-tracker.spec.ts` → 全绿。

- [ ] **写失败测试（3/3）** inflight 续上 `packages/web-common/src/session/watch-inflight.spec.ts`：

```ts
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { inflightToSnapshotEvent } from "./watch-inflight";

describe("inflightToSnapshotEvent（D7 中途续上）", () => {
  it("null / undefined → null（无活跃 run，不是错误）", () => {
    expect(inflightToSnapshotEvent("s1", null)).toBeNull();
    expect(inflightToSnapshotEvent("s1", undefined)).toBeNull();
  });

  it("messageId 为 null → null（已落库轮，不该当 inflight 重复推）", () => {
    expect(
      inflightToSnapshotEvent("s1", {
        messageId: null, content: "", reasoning: "", reasoningStartedAt: null,
        toolCalls: [], status: "done",
      }),
    ).toBeNull();
  });

  it("有活跃 partial → 合成 run.snapshot 事件", () => {
    expect(
      inflightToSnapshotEvent("s1", {
        messageId: "m1", content: "半截输出", reasoning: "想了想",
        reasoningStartedAt: 1234, toolCalls: [{ toolCallId: "t1", name: "read", argsText: "{\"p\":" }],
        status: "streaming",
      }),
    ).toEqual({
      event: SESSION_WS_EVENTS.runSnapshot,
      payload: {
        sessionId: "s1",
        messageId: "m1",
        reasoning: "想了想",
        content: "半截输出",
        reasoningStartedAt: 1234,
        toolCalls: [{ toolCallId: "t1", name: "read", argsText: "{\"p\":" }],
      },
    });
  });

  it("形状不符（非对象 / 缺字段）→ null，不抛", () => {
    expect(inflightToSnapshotEvent("s1", "字符串")).toBeNull();
    expect(inflightToSnapshotEvent("s1", { 乱七八糟: 1 })).toBeNull();
  });
});
```

- [ ] **最小实现** `packages/web-common/src/session/watch-inflight.ts`：

```ts
import {
  type RunSnapshotEvent,
  RunSnapshotEventSchema,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";

/**
 * 把 `watch_accepted.inflight`（设备侧 `RunnerService.getInflight` 的
 * `InflightView`）合成一条 `run.snapshot` 事件（spec D7 中途续上）。
 *
 * 为什么合成 `run.snapshot` 而不是自定义事件：`useSessionStream` 已经有一条
 * 处理 `run.snapshot` 的成熟路径（本地会话中途订阅时 `session.gateway.ts`
 * 就是这么补发的），观察者复用它就能直接渲染半截输出 + 半截 tool args——
 * **前端上层处理逻辑一份**（spec D9 的统一契约落点），不必为远程观察另造
 * 一条渲染分支。
 *
 * 返回 null 的三种情况（都不是错误）：
 * - `inflight` 为 null/undefined —— 该会话当前没在跑；
 * - `messageId` 为 null —— 本轮 assistant 已 `recordAssistant` 落库，不再是活
 *   partial，历史接口会给出完整内容，当 inflight 重推会导致「思考中」误计时；
 * - 形状校验不过 —— relay 透传的是 `unknown`，防御性返回 null 而非抛错。
 */
export function inflightToSnapshotEvent(
  sessionId: string,
  inflight: unknown,
): { event: string; payload: RunSnapshotEvent } | null {
  if (!inflight || typeof inflight !== "object") return null;
  const view = inflight as { messageId?: unknown };
  if (typeof view.messageId !== "string") return null;
  const parsed = RunSnapshotEventSchema.safeParse({
    ...(inflight as Record<string, unknown>),
    sessionId,
  });
  if (!parsed.success) return null;
  return { event: SESSION_WS_EVENTS.runSnapshot, payload: parsed.data };
}
```

- [ ] **跑过**：`npx jest packages/web-common/src/session/watch-inflight.spec.ts` → 4 passed。
- [ ] **导出**：`packages/web-common/src/session/index.ts` 追加 `export { inflightToSnapshotEvent } from "./watch-inflight";`（按该文件字母序插入）。
- [ ] **约束自检**：`grep -rn "jotai\|next-intl\|apiClient\|next/navigation" packages/web-common/src/session/watch-inflight.ts packages/web-common/src/session/remote-run-tracker.ts` → **零命中**（web-common 禁碰这四样）。
- [ ] **回归**：`npx jest packages/web-common 2>&1 | tail -20` → 零新增失败。
- [ ] **commit**：`feat(web-common): tracker 支持 watchId 通道 + D6 抑制 + FrameSequencer 中途接入 + inflight 续上`

---

## Task 12：web-main 观察者接线 —— ⭐ **可中断交付点 A**

做完本 Task，「**云端看本地设备的实时输出**」端到端可用：web-main 打开一个远程会话 → 自动 session-watch → 对端（设备本地浏览器 / 另一台设备）发起的 run 实时流式呈现 → 中途进入用 inflight 续上半截输出。**此处可停，独立交付验证。**

**Files:**
- `apps/web-main/src/lib/session-transport.ts`（改：watch 接线）
- `apps/web-main/src/lib/session-transport.spec.ts`（新/改）

**Interfaces:**

Produces（`SessionTransport` 契约扩展；T19 的 web-agent 实现同签名）：

```ts
interface SessionTransport {
  // ...既有
  /**
   * 开始观察某会话的推理帧（Session 级 watch）。返回 unwatch 函数。
   * 本地会话实现可为 no-op（本机 ws/session 已经实时）。
   */
  watchSession?: (sessionId: string) => () => void;
}
```

Consumes：T1 事件常量、T11 的 `RemoteRunTracker.registerWatch/releaseWatch` 与 `inflightToSnapshotEvent`。

### 步骤

- [ ] **写失败测试** `apps/web-main/src/lib/session-transport.spec.ts`（沿用该 app 既有的 socket mock 风格；若无先建最小 fake socket）：

```ts
import { IM_WS_EVENTS } from "@meshbot/types";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";

// getImSocket 需 mock 成可断言 emit / 可主动 fire 的 fake
jest.mock("./im-socket", () => ({ getImSocket: () => fakeSocket }));

describe("web-main 远程 transport：观察通道", () => {
  it("watchSession 发出 agent.watch.start（scope=session）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchSession!("s1");
    const [, body] = fakeSocket.emitted.find(([e]) => e === IM_WS_EVENTS.agentWatchStart)!;
    expect(body).toMatchObject({ targetAgentId: "cloud-a1", scope: "session", sessionId: "s1" });
    expect((body as { watchId: string }).watchId).toBeTruthy();
  });

  it("watch_accepted{ok:true,inflight} → 合成 run.snapshot 吐给订阅者（D7 续上）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: Array<[string, unknown]> = [];
    t.subscribe({ onEvent: (e, p) => seen.push([e, p]) });
    t.watchSession!("s1");
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId, ok: true,
      inflight: { messageId: "m1", content: "半截", reasoning: "", reasoningStartedAt: null, toolCalls: [], status: "streaming" },
    });
    expect(seen).toContainEqual([
      SESSION_WS_EVENTS.runSnapshot,
      expect.objectContaining({ sessionId: "s1", messageId: "m1", content: "半截" }),
    ]);
  });

  it("受理后到达的 watch 帧被吐给订阅者（中途接入 seq 非 1 也能吐）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: Array<[string, unknown]> = [];
    t.subscribe({ onEvent: (e, p) => seen.push([e, p]) });
    t.watchSession!("s1");
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, { watchId, ok: true, inflight: null });
    fakeSocket.fire(IM_WS_EVENTS.agentRunFrame, {
      watchId, requesterDeviceId: "user:x", seq: 42,
      sessionId: "s1", event: SESSION_WS_EVENTS.runChunk, payload: { sessionId: "s1", delta: "对端输出" },
    });
    expect(seen).toContainEqual([
      SESSION_WS_EVENTS.runChunk,
      { sessionId: "s1", delta: "对端输出" },
    ]);
  });

  it("watch_accepted{ok:false} → 不登记通道，后续帧不吐（设备拒了）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: Array<[string, unknown]> = [];
    t.subscribe({ onEvent: (e, p) => seen.push([e, p]) });
    t.watchSession!("s1");
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, { watchId, ok: false, reason: "offline" });
    fakeSocket.fire(IM_WS_EVENTS.agentRunFrame, {
      watchId, requesterDeviceId: "user:x", seq: 1,
      sessionId: "s1", event: SESSION_WS_EVENTS.runChunk, payload: {},
    });
    expect(seen.filter(([e]) => e === SESSION_WS_EVENTS.runChunk)).toHaveLength(0);
  });

  it("unwatch 函数发出 agent.watch.stop 并释放本地登记（泄漏防线）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const un = t.watchSession!("s1");
    const watchId = watchIdOfLastStart();
    un();
    expect(fakeSocket.emitted).toContainEqual([IM_WS_EVENTS.agentWatchStop, { watchId }]);
  });

  it("unwatch 幂等（重复调用只发一次 stop）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const un = t.watchSession!("s1");
    un();
    un();
    expect(fakeSocket.emitted.filter(([e]) => e === IM_WS_EVENTS.agentWatchStop)).toHaveLength(1);
  });

  it("dispose 摘除全部监听器并释放全部 watch（remount 不累积）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchSession!("s1");
    const before = fakeSocket.listenerCount(IM_WS_EVENTS.agentWatchAccepted);
    t.dispose!();
    expect(fakeSocket.listenerCount(IM_WS_EVENTS.agentWatchAccepted)).toBe(before - 1);
    expect(fakeSocket.emitted).toContainEqual([
      IM_WS_EVENTS.agentWatchStop, expect.anything(),
    ]);
  });

  it("socket 重连（connect）→ 自动重 watch（D5 断线重连自动重 watch）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchSession!("s1");
    const firstId = watchIdOfLastStart();
    fakeSocket.fire("connect");
    const secondId = watchIdOfLastStart();
    expect(secondId).not.toBe(firstId);       // 新 watchId（旧的已随断线在云端被清）
    expect(fakeSocket.emitted.filter(([e]) => e === IM_WS_EVENTS.agentWatchStart)).toHaveLength(2);
  });
});
```

- [ ] **跑挂**：`npx jest apps/web-main/src/lib/session-transport.spec.ts`。

- [ ] **最小实现**——`apps/web-main/src/lib/session-transport.ts`：
  - 新增两个监听器（连同既有 `agentRunFrame` / `agentRunEnd` 一起在 `dispose` 摘除）：

```ts
  /** watchId → 该通道观察的 sessionId（重连重 watch 与 unwatch 用）。 */
  const activeWatches = new Map<string, string>();

  const onWatchAccepted = (accepted: AgentWatchAccepted) => {
    const sessionId = pendingWatches.get(accepted.watchId);
    if (!sessionId) return; // 非本实例发起的 watch
    pendingWatches.delete(accepted.watchId);
    if (!accepted.ok) {
      // 设备拒绝（离线 / Agent 不可远程 / 会话不归它）：不登记通道，观察者
      // 退化为「不实时」。上层据此可提示——本层不弹窗（web-common 不碰 i18n），
      // 由调用方消费 onWatchRejected 回调（本轮先只 console.warn，UI 提示留待
      // 使用方接入时补，见 spec「设备离线 → 观察者提示，不静默」）。
      console.warn(`观察通道被拒（watchId=${accepted.watchId}, reason=${accepted.reason}）`);
      return;
    }
    activeWatches.set(accepted.watchId, sessionId);
    runs.registerWatch(accepted.watchId, sessionId);
    // D7 中途续上：把 inflight 快照合成 run.snapshot 事件先吐一发，
    // 观察者立刻渲染半截输出，之后的增量帧接着往上贴。
    const snapshot = inflightToSnapshotEvent(sessionId, accepted.inflight);
    if (snapshot) runEvents.emit(snapshot.event, snapshot.payload);
  };

  /**
   * 断线重连自动重 watch（D5）：云端在观察者 socket 断开时已把该连接的全部
   * watch 路由清掉（泄漏防线 2），重连后是一条**新 socket**（socketId 变了，
   * requester 身份也变了），必须用**新 watchId** 重新发起——沿用旧 watchId 会
   * 在云端建出一条 requester 指向已死 socketId 的路由。
   */
  const onReconnect = () => {
    const sessionIds = [...new Set([...activeWatches.values(), ...pendingWatches.values()])];
    activeWatches.clear();
    pendingWatches.clear();
    runs.resetWatches();
    for (const sessionId of sessionIds) startWatch(sessionId);
  };

  socket.on(IM_WS_EVENTS.agentWatchAccepted, onWatchAccepted);
  socket.on("connect", onReconnect);
```

  - `watchSession` 实现：

```ts
    /**
     * 开始观察某会话的推理帧（Session 级 watch，spec D5「打开会话即 session-watch」）。
     * 返回 unwatch 函数（幂等）——调用方在会话视图卸载 / 切换会话时必须调用，
     * 否则设备侧常驻转发器要等满 5 分钟 idle 才拆（能兜住，但白占资源）。
     */
    watchSession(sessionId: string) {
      const watchId = startWatch(sessionId);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        activeWatches.delete(watchId);
        pendingWatches.delete(watchId);
        runs.releaseWatch(watchId);
        socket.emit(IM_WS_EVENTS.agentWatchStop, { watchId } satisfies AgentWatchStopInput);
      };
    },
```

  - 私有 `startWatch`：

```ts
  const pendingWatches = new Map<string, string>();

  /** 发起一路 Session 级 watch，返回本次的 watchId（受理前先记 pending）。 */
  const startWatch = (sessionId: string): string => {
    const watchId = clientSnowflakeId();
    pendingWatches.set(watchId, sessionId);
    socket.emit(IM_WS_EVENTS.agentWatchStart, {
      watchId,
      targetAgentId: agentId,
      scope: "session",
      sessionId,
    } satisfies AgentWatchStartInput);
    return watchId;
  };
```

  - `dispose` 追加：

```ts
      for (const watchId of [...activeWatches.keys(), ...pendingWatches.keys()]) {
        socket.emit(IM_WS_EVENTS.agentWatchStop, { watchId } satisfies AgentWatchStopInput);
      }
      activeWatches.clear();
      pendingWatches.clear();
      socket.off(IM_WS_EVENTS.agentWatchAccepted, onWatchAccepted);
      socket.off("connect", onReconnect);
```

  - `RemoteRunTracker` 需补一个 `resetWatches()`（只清 watch 表、不动 stream 表）——回到 T11 补上并补测（`it("resetWatches 只清 watch 不动 stream")`）。

  - 调用方接线：会话视图组件（`useSessionStream` 的宿主）在 remote 分支 `useEffect` 里调 `transport.watchSession?.(sessionId)`，cleanup 调返回的 unwatch。**定位命令**：

```bash
grep -rn "useSessionStream(" apps/web-main/src --include="*.tsx" | head
```

- [ ] **跑过**：`npx jest apps/web-main/src/lib/session-transport.spec.ts` → 8 passed。
- [ ] **构建校验**：

```bash
pnpm --filter @meshbot/web-main build 2>&1 | tail -20
```
期望 `Compiled successfully`（**读完整输出**）。

- [ ] **围栏 + 类型**：`pnpm typecheck 2>&1 | tail -20 && pnpm check 2>&1 | tail -30` → 全绿。
- [ ] **i18n**：本 Task 若加了用户可见文案（观察通道被拒的提示），跑 `pnpm sync:locales --write` 补 stub 并填 zh/en 实文案，再跑 `pnpm sync:locales` 确认 **missing=0**。
- [ ] **commit**：`feat(web-main): 会话观察通道接线（session-watch + inflight 续上 + 重连重 watch）`

### ⭐ 交付点 A 手工验证清单

前置：两台设备（或一台设备 + 一个浏览器）登录同一账号，设备 B 有一个 `remote_enabled` 的 Agent。

1. 设备 B 本机 web-agent 打开会话 S，发一条消息让它跑起来。
2. 浏览器打开 web-main，进入设备 B 的 Agent → 打开会话 S。
3. **期望**：立刻看到半截输出（inflight 续上），之后的 chunk 实时往上贴，直到 run.done。
4. 在设备 B 本机继续发第二轮消息。
5. **期望（跨多轮存活，本设计的关键差异）**：web-main 上第二轮同样实时流式呈现，**无需刷新**。
6. 关闭 web-main 页签，等 5 秒，看设备 B 日志出现 `会话观察通道 idle 拆除` 之前的 stop 通知（即云端断线清理生效）。

---

## Task 13：`SessionService` 补生命周期发射点

修缺口 ② 的第一半：本地事件源就位。spec §C1 明确「事件源已存在（`SessionService` 的增删改、`RunnerService` 的 status），本轮只是**多加一条出口**，不改事件本身」——但实机核对后确认：**`session.created/deleted/renamed` 三个事件在进程内根本不存在**（只有 `SESSION_STATUS_EVENTS.changed` 已在 `runner.service.ts:136` 发射）。本 Task 补齐这三个发射点。

**Files:**
- `apps/server-agent/src/services/session.service.ts`（改：注入 `EventEmitter2` + 4 处 emit）
- `apps/server-agent/src/services/session.service.spec.ts`（改：补发射断言）
- `apps/server-agent/src/services/runner.service.ts`（改：`status_changed` 补 `agentId`，承接 T2）

**Interfaces:**

Produces（T14 消费）：进程内 EventEmitter2 事件 `session.created` / `session.deleted` / `session.renamed`，payload 形状见 T2。

Consumes：T2 的 `SESSION_LIFECYCLE_EVENTS` 与三个 Event 类型。

**发射点选择（照 `AGENT_EVENTS.changed` 的既有理由）**：下沉到 Service 而非 Controller——这样 REST 建会话、远程 run 建会话（`RemoteRunInboundService`）、定时任务建会话、`AgentService.removeWithData` 级联删会话、`SessionTitleService` 自动生成标题**所有路径**自动共享同一个事件，不会有某条路径静默不通知的洞。

**不发射的两处（刻意）**：
- `createSubSession`：子 Agent 会话不是用户会话，侧栏不显示（`listAllSorted` 也排除 `kind=subagent`），发了只会污染观察者的会话列表。
- `setStatus`：状态变化已有 `SESSION_STATUS_EVENTS.changed` 走 `RunnerService`，不重复发。

### 步骤

- [ ] **写失败测试**——追加到 `apps/server-agent/src/services/session.service.spec.ts`：

```ts
import { SESSION_LIFECYCLE_EVENTS } from "@meshbot/types-agent";

describe("SessionService 生命周期事件", () => {
  it("createSession → 发 session.created（携带 agentId 与完整 summary）", async () => {
    const { svc, emitted } = makeService();
    const { session } = await svc.createSession({ content: "你好", agentId: "a1" });
    expect(emitted).toContainEqual([
      SESSION_LIFECYCLE_EVENTS.created,
      { agentId: "a1", session },
    ]);
  });

  it("createSubSession 不发 created（子 Agent 会话不进侧栏）", async () => {
    const { svc, emitted } = makeService();
    await svc.createSubSession({ parentSessionId: "s0", parentToolCallId: "t1", task: "干活" });
    expect(emitted.filter(([e]) => e === SESSION_LIFECYCLE_EVENTS.created)).toHaveLength(0);
  });

  it("deleteSession → 发 session.deleted（agentId 取自删除前查到的会话）", async () => {
    const { svc, emitted } = makeService({ session: { id: "s1", agentId: "a1" } });
    await svc.deleteSession("s1");
    expect(emitted).toContainEqual([
      SESSION_LIFECYCLE_EVENTS.deleted,
      { agentId: "a1", sessionId: "s1" },
    ]);
  });

  it("patch 改 title → 发 session.renamed", async () => {
    const { svc, emitted } = makeService({ session: { id: "s1", agentId: "a1", title: "新名" } });
    await svc.patch("s1", { title: "新名" });
    expect(emitted).toContainEqual([
      SESSION_LIFECYCLE_EVENTS.renamed,
      { agentId: "a1", sessionId: "s1", title: "新名" },
    ]);
  });

  it("patch 只改 pinned → 不发 renamed（没改名）", async () => {
    const { svc, emitted } = makeService({ session: { id: "s1", agentId: "a1", title: "旧名" } });
    await svc.patch("s1", { pinned: true });
    expect(emitted.filter(([e]) => e === SESSION_LIFECYCLE_EVENTS.renamed)).toHaveLength(0);
  });

  it("patchIfNotGenerated 生效 → 发 renamed（LLM 自动生成标题路径）", async () => {
    const { svc, emitted } = makeService({ session: { id: "s1", agentId: "a1", title: "生成的名" } });
    await svc.patchIfNotGenerated("s1", "生成的名");
    expect(emitted).toContainEqual([
      SESSION_LIFECYCLE_EVENTS.renamed,
      { agentId: "a1", sessionId: "s1", title: "生成的名" },
    ]);
  });

  it("patchIfNotGenerated 未生效（用户已手动改名）→ 不发 renamed", async () => {
    const { svc, emitted } = makeService({ updateAffected: 0 });
    await svc.patchIfNotGenerated("s1", "被丢弃的名");
    expect(emitted.filter(([e]) => e === SESSION_LIFECYCLE_EVENTS.renamed)).toHaveLength(0);
  });
});
```

  > `makeService` 需扩展：注入一个收集 `[event, payload]` 的伪 `EventEmitter2`（`{ emit: (e, p) => emitted.push([e, p]) }`）。

- [ ] **跑挂**：`npx jest apps/server-agent/src/services/session.service.spec.ts` → 新 describe 全红。

- [ ] **最小实现**——`session.service.ts`：
  - 构造函数注入 `private readonly emitter: EventEmitter2`（加在参数列表末尾，避免打乱既有位置参数的伪实现测试）。
  - `createSession` 改为：

```ts
  async createSession(
    input: CreateSessionInput & { agentId: string },
  ): Promise<{ sessionId: string; session: SessionSummary }> {
    const created = await this.createSessionInTx(input);
    // 生命周期事件（统一契约，spec §A）：本地端经 ws/events 消费，远程 Agent 级
    // 观察者经 relay 镜像消费。发射点在 Service 而非 Controller——REST 建会话、
    // 远程 run 入站建会话、定时任务建会话三条路径自动共享，不留静默洞。
    // 放在事务方法**之外**：事务未提交就通知，观察者回查会看不到这条会话。
    this.emitter.emit(SESSION_LIFECYCLE_EVENTS.created, {
      agentId: input.agentId,
      session: created.session,
    } satisfies SessionCreatedEvent);
    return created;
  }
```

  - `deleteSession`：`findSessionOrFail` 的返回值本来被丢弃，改为接住取 `agentId`；emit 放在**全部删除完成之后**：

```ts
  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.findSessionOrFail(sessionId);
    await this.deleteSessionInTx(sessionId);
    await this.schedules.deleteBySession(sessionId);
    await this.checkpointer.deleteThread(sessionId);
    // 删完才通知：先通知的话观察者可能在数据还在时就把行移除，然后被某个
    // 并发的列表刷新又加回来（闪回）。
    this.emitter.emit(SESSION_LIFECYCLE_EVENTS.deleted, {
      agentId: session.agentId,
      sessionId,
    } satisfies SessionDeletedEvent);
  }
```

  - `patch`：只在 `input.title !== undefined` 时发：

```ts
    const s = await this.findSessionOrFail(sessionId);
    if (input.title !== undefined) {
      this.emitter.emit(SESSION_LIFECYCLE_EVENTS.renamed, {
        agentId: s.agentId,
        sessionId,
        title: s.title,
      } satisfies SessionRenamedEvent);
    }
    return toSummary(s);
```

  - `patchIfNotGenerated`：只在 `res.affected` 非 0 时发（用户已手改名则本次写入被丢弃，不该通知）：

```ts
    if (!res.affected) return null;
    const s = await this.findSessionOrFail(sessionId);
    this.emitter.emit(SESSION_LIFECYCLE_EVENTS.renamed, {
      agentId: s.agentId,
      sessionId,
      title: s.title,
    } satisfies SessionRenamedEvent);
    return toSummary(s);
```

  - `runner.service.ts:136` 的 `SESSION_STATUS_EVENTS.changed` 补 `agentId`（T2 已为编译修过，此处确认语义正确：取该会话真实的 `agentId`，不是当前 Agent 上下文）。

- [ ] **跑过**：`npx jest apps/server-agent/src/services/session.service.spec.ts 2>&1 | tail -20` → 全绿（**含既有用例，读完整输出**）。
- [ ] **围栏**：`pnpm check:tx && pnpm check:naming && pnpm check:repo 2>&1 | tail -20` → 全绿。**特别确认 `check:tx` 没因为 emit 被误判**——emit 在事务方法之外，事务边界未变。
- [ ] **boot 验证**（改了 `SessionService` 构造签名，DI 面变了）：

```bash
pnpm --filter @meshbot/server-agent build \
  && timeout 60 node apps/server-agent/dist/main.js 2>&1 | tail -40
```
期望 `Nest application successfully started`。

- [ ] **commit**：`feat(server-agent): SessionService 补会话生命周期事件发射点（created/deleted/renamed）`

---

## Task 14：Agent 级镜像器 `AgentWatchMirrorService`

修缺口 ② 的第二半：把本地生命周期事件镜像上 relay。spec §C1：「按 `agentId` 判断有无观察者，无则不镜像（零成本）」。

**设备侧怎么知道「有没有 Agent 级观察者」**：`AgentWatchInboundService`（T6）收到 `scope:"agent"` 的 start/stop 时把 `(cloudUserId, localAgentId) → Set<watchId>` 记在本服务里。这是设备侧唯一需要的 Agent 级状态（Session 级的常驻转发器状态在 `SessionWatchService`）。

**Files:**
- `apps/server-agent/src/services/agent-watch-mirror.service.ts`（新）
- `apps/server-agent/src/services/agent-watch-mirror.service.spec.ts`（新）
- `apps/server-agent/src/services/agent-watch-inbound.service.ts`（改：agent scope 分支登记/注销到本服务）
- `apps/server-agent/src/services/agent-watch-inbound.service.spec.ts`（改：补断言）

**Interfaces:**

Produces：

```ts
@Injectable()
class AgentWatchMirrorService {
  /** 登记一个 Agent 级观察者（`AgentWatchInboundService` 在 scope="agent" 时调）。 */
  addWatcher(cloudUserId: string, localAgentId: string, watchId: string): void;
  removeWatcher(watchId: string): void;
  /** 该 Agent 当前是否有观察者（决定要不要镜像；无则零成本）。 */
  hasWatcher(cloudUserId: string, localAgentId: string): boolean;

  @OnEvent(SESSION_LIFECYCLE_EVENTS.created)  onCreated(p: SessionCreatedEvent): void;
  @OnEvent(SESSION_LIFECYCLE_EVENTS.deleted)  onDeleted(p: SessionDeletedEvent): void;
  @OnEvent(SESSION_LIFECYCLE_EVENTS.renamed)  onRenamed(p: SessionRenamedEvent): void;
  @OnEvent(SESSION_STATUS_EVENTS.changed)     onStatusChanged(p: SessionStatusChangedEvent): void;
}
```

Consumes：T2 的事件、`AccountContextService.get()`（拿当前账号）、`ImRelayClientService.emitAgentWatchFrame`。

### 步骤

- [ ] **写失败测试** `apps/server-agent/src/services/agent-watch-mirror.service.spec.ts`：

```ts
import type { AgentWatchFrame } from "@meshbot/types";
import { SESSION_LIFECYCLE_EVENTS, SESSION_STATUS_EVENTS } from "@meshbot/types-agent";
import { AgentWatchMirrorService } from "./agent-watch-mirror.service";

describe("AgentWatchMirrorService（Agent 级生命周期镜像）", () => {
  const mk = (cloudUserId: string | null = "u1") => {
    const sent: Array<{ cloudUserId: string; frame: AgentWatchFrame }> = [];
    const relay = {
      emitAgentWatchFrame: (u: string, f: AgentWatchFrame) => sent.push({ cloudUserId: u, frame: f }),
    };
    const account = { get: () => cloudUserId };
    const svc = new AgentWatchMirrorService(relay as never, account as never);
    return { svc, sent };
  };

  const summary = { id: "s9", title: "新会话", agentId: "a1" };

  it("无观察者时不镜像（零成本）", () => {
    const { svc, sent } = mk();
    svc.onCreated({ agentId: "a1", session: summary as never });
    expect(sent).toEqual([]);
  });

  it("有观察者时镜像 session.created", () => {
    const { svc, sent } = mk();
    svc.addWatcher("u1", "a1", "w1");
    svc.onCreated({ agentId: "a1", session: summary as never });
    expect(sent).toEqual([
      {
        cloudUserId: "u1",
        frame: {
          localAgentId: "a1",
          scope: "agent",
          sessionId: "s9",
          seq: 1,
          event: SESSION_LIFECYCLE_EVENTS.created,
          payload: { agentId: "a1", session: summary },
        },
      },
    ]);
  });

  it("只镜像被观察的那个 Agent（别的 Agent 的事件不外发）", () => {
    const { svc, sent } = mk();
    svc.addWatcher("u1", "a1", "w1");
    svc.onCreated({ agentId: "别的Agent", session: { ...summary, agentId: "别的Agent" } as never });
    expect(sent).toEqual([]);
  });

  it("多观察者仍只镜像一份（云端 fan-out）", () => {
    const { svc, sent } = mk();
    svc.addWatcher("u1", "a1", "w1");
    svc.addWatcher("u1", "a1", "w2");
    svc.onDeleted({ agentId: "a1", sessionId: "s9" });
    expect(sent).toHaveLength(1);
  });

  it("deleted / renamed / status_changed 三类都镜像", () => {
    const { svc, sent } = mk();
    svc.addWatcher("u1", "a1", "w1");
    svc.onDeleted({ agentId: "a1", sessionId: "s9" });
    svc.onRenamed({ agentId: "a1", sessionId: "s9", title: "改了" });
    svc.onStatusChanged({ agentId: "a1", sessionId: "s9", status: "running" });
    expect(sent.map((s) => s.frame.event)).toEqual([
      SESSION_LIFECYCLE_EVENTS.deleted,
      SESSION_LIFECYCLE_EVENTS.renamed,
      SESSION_STATUS_EVENTS.changed,
    ]);
  });

  it("seq 按 Agent 单调递增（观察者据此重排）", () => {
    const { svc, sent } = mk();
    svc.addWatcher("u1", "a1", "w1");
    svc.onDeleted({ agentId: "a1", sessionId: "s1" });
    svc.onDeleted({ agentId: "a1", sessionId: "s2" });
    expect(sent.map((s) => s.frame.seq)).toEqual([1, 2]);
  });

  it("末个观察者离开后停止镜像", () => {
    const { svc, sent } = mk();
    svc.addWatcher("u1", "a1", "w1");
    svc.removeWatcher("w1");
    svc.onCreated({ agentId: "a1", session: summary as never });
    expect(sent).toEqual([]);
  });

  it("无账号上下文时不镜像（不猜账号，避免跨账号泄漏）", () => {
    const { svc, sent } = mk(null);
    svc.addWatcher("u1", "a1", "w1");
    svc.onCreated({ agentId: "a1", session: summary as never });
    expect(sent).toEqual([]);
  });

  it("账号不匹配时不镜像（u2 的事件不发给 u1 的观察者）", () => {
    const { svc, sent } = mk("u2");
    svc.addWatcher("u1", "a1", "w1");
    svc.onCreated({ agentId: "a1", session: summary as never });
    expect(sent).toEqual([]);
  });

  it("removeWatcher 未知 watchId 不抛", () => {
    const { svc } = mk();
    expect(() => svc.removeWatcher("不存在")).not.toThrow();
  });
});
```

- [ ] **跑挂**：`npx jest apps/server-agent/src/services/agent-watch-mirror.service.spec.ts`。

- [ ] **最小实现** `apps/server-agent/src/services/agent-watch-mirror.service.ts`：

```ts
import { AccountContextService } from "@meshbot/lib-agent";
import type { AgentWatchFrame } from "@meshbot/types";
import {
  SESSION_LIFECYCLE_EVENTS,
  SESSION_STATUS_EVENTS,
  type SessionCreatedEvent,
  type SessionDeletedEvent,
  type SessionRenamedEvent,
  type SessionStatusChangedEvent,
} from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { ImRelayClientService } from "../cloud/im-relay-client.service";

/**
 * Agent 级会话生命周期镜像器（spec §C1，修缺口 ②「A 远程建的会话，B 上不
 * 实时出现」）。
 *
 * 本地已有一套 `ws/events` 全局总线事件（`session.created/deleted/renamed/
 * status_changed`），但**只走本机 ws/events，不经 relay**——所以远端建的会话、
 * 改的名，对端要刷新才看得到。本服务就是那条**多出来的出口**：同一批事件，
 * 在**有 Agent 级观察者时**额外镜像一份上 relay，云端按 `agentWatchers` 索引
 * fan-out 给各观察者。
 *
 * **不改事件本身**（spec §C1 明确）：本服务只 `@OnEvent` 旁听，不影响既有
 * `EventsGateway` 的本机下发路径。
 *
 * **无观察者 = 零成本**：`hasWatcher` 是一次 Map 查找，没人看时直接 return，
 * 不组帧、不碰 relay。
 *
 * **设备只镜像一份**：同一 Agent 有 N 个观察者时仍只发一份（同
 * `SessionWatchService` 的取舍），云端负责扇出。
 *
 * **账号隔离**：事件发射方（`SessionService`）总在某个账号的
 * `AccountContextService` 上下文内，本服务据此取 `cloudUserId` 并与观察者登记
 * 的账号比对——取不到账号或账号不匹配一律不镜像，宁可退化为「不实时」也绝不
 * 跨账号泄漏会话标题。
 */
@Injectable()
export class AgentWatchMirrorService {
  /** `${cloudUserId}:${localAgentId}` → 观察者 watchId 集合。 */
  private readonly watchers = new Map<string, Set<string>>();
  /** watchId → 上面的键，供 `removeWatcher` 反查。 */
  private readonly watchIndex = new Map<string, string>();
  /** 每个被观察 Agent 的镜像帧序号（观察者按此重排）。 */
  private readonly seqs = new Map<string, number>();

  constructor(
    private readonly relay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {}

  private static key(cloudUserId: string, localAgentId: string): string {
    return `${cloudUserId}:${localAgentId}`;
  }

  /** 登记一个 Agent 级观察者（`AgentWatchInboundService` 在 scope="agent" 时调）。 */
  addWatcher(cloudUserId: string, localAgentId: string, watchId: string): void {
    const key = AgentWatchMirrorService.key(cloudUserId, localAgentId);
    let set = this.watchers.get(key);
    if (!set) {
      set = new Set<string>();
      this.watchers.set(key, set);
    }
    set.add(watchId);
    this.watchIndex.set(watchId, key);
  }

  /**
   * 注销一个 Agent 级观察者。集合空即删键 + 清 seq 计数——Agent 级没有
   * Session 级那种「刷新期间反复挂退」的成本（这里挂的不是 EventEmitter2
   * 监听器，只是一个 Set 条目），故不需要 idle 宽限期，立即回收。
   */
  removeWatcher(watchId: string): void {
    const key = this.watchIndex.get(watchId);
    if (!key) return;
    this.watchIndex.delete(watchId);
    const set = this.watchers.get(key);
    if (!set) return;
    set.delete(watchId);
    if (set.size === 0) {
      this.watchers.delete(key);
      this.seqs.delete(key);
    }
  }

  /** 该 Agent 当前是否有观察者。 */
  hasWatcher(cloudUserId: string, localAgentId: string): boolean {
    return (
      (this.watchers.get(AgentWatchMirrorService.key(cloudUserId, localAgentId))
        ?.size ?? 0) > 0
    );
  }

  @OnEvent(SESSION_LIFECYCLE_EVENTS.created)
  onCreated(payload: SessionCreatedEvent): void {
    this.mirror(
      payload.agentId,
      payload.session.id,
      SESSION_LIFECYCLE_EVENTS.created,
      payload,
    );
  }

  @OnEvent(SESSION_LIFECYCLE_EVENTS.deleted)
  onDeleted(payload: SessionDeletedEvent): void {
    this.mirror(
      payload.agentId,
      payload.sessionId,
      SESSION_LIFECYCLE_EVENTS.deleted,
      payload,
    );
  }

  @OnEvent(SESSION_LIFECYCLE_EVENTS.renamed)
  onRenamed(payload: SessionRenamedEvent): void {
    this.mirror(
      payload.agentId,
      payload.sessionId,
      SESSION_LIFECYCLE_EVENTS.renamed,
      payload,
    );
  }

  @OnEvent(SESSION_STATUS_EVENTS.changed)
  onStatusChanged(payload: SessionStatusChangedEvent): void {
    this.mirror(
      payload.agentId,
      payload.sessionId,
      SESSION_STATUS_EVENTS.changed,
      payload,
    );
  }

  /** 有观察者才组帧上 relay；无人看时零成本返回。 */
  private mirror(
    localAgentId: string,
    sessionId: string,
    event: string,
    payload: unknown,
  ): void {
    const cloudUserId = this.account.get();
    if (!cloudUserId) return; // 无账号上下文：不猜，宁可不实时也不跨账号泄漏
    const key = AgentWatchMirrorService.key(cloudUserId, localAgentId);
    if ((this.watchers.get(key)?.size ?? 0) === 0) return;
    const seq = (this.seqs.get(key) ?? 0) + 1;
    this.seqs.set(key, seq);
    this.relay.emitAgentWatchFrame(cloudUserId, {
      localAgentId,
      scope: "agent",
      sessionId,
      seq,
      event,
      payload,
    } satisfies AgentWatchFrame);
  }
}
```

- [ ] **跑过**：`npx jest apps/server-agent/src/services/agent-watch-mirror.service.spec.ts` → 10 passed。

- [ ] **接线 `AgentWatchInboundService`**——注入 `AgentWatchMirrorService`，改两处：
  - `action === "stop"` 分支同时调两个服务（不知道是哪一级，两边都注销，各自对未知 watchId 幂等）：

```ts
    if (action === "stop") {
      // 不区分 scope：stop 帧只带 watchId，两级各自对未知 id 幂等，都调一遍最简单可靠。
      this.watches.removeWatcher(watchId);
      this.mirror.removeWatcher(watchId);
      return;
    }
```

  - `scope === "agent"` 分支补登记：

```ts
        if (scope === "agent") {
          this.mirror.addWatcher(cloudUserId, agent.id, watchId);
          this.relay.emitAgentWatchAccepted(cloudUserId, {
            watchId,
            ok: true,
            inflight: null,
          });
          return;
        }
```

  - 对应把 T6 那条 `expect(watches.addWatcher).not.toHaveBeenCalled()` 的 agent scope 用例改为断言 `mirror.addWatcher` 被调用（**改测试是因为契约本身在本 Task 才补全，不是迁就实现**）。

- [ ] **module 注册**：`AgentWatchMirrorService` 加到与 `AgentWatchInboundService` 同一 module 的 providers。
- [ ] **跑过**：`npx jest apps/server-agent/src/services/agent-watch 2>&1 | tail -20` → 两个 spec 全绿。
- [ ] **boot 验证**：

```bash
pnpm --filter @meshbot/server-agent build \
  && timeout 60 node apps/server-agent/dist/main.js 2>&1 | tail -40
```
期望 `Nest application successfully started`。

- [ ] **commit**：`feat(server-agent): 新增 AgentWatchMirrorService（有观察者才镜像生命周期事件，零成本旁路）`

---

## Task 15：前端消费生命周期事件 —— ⭐ **可中断交付点 B**

做完本 Task，「**A 远程建的会话，B 上实时出现**」端到端可用。**此处可停，独立交付验证。**

**Files:**
- `packages/web-common/src/session/session-list-events.ts`（新：纯逻辑归并函数）
- `packages/web-common/src/session/session-list-events.spec.ts`（新）
- `packages/web-common/src/session/index.ts`（改：导出）
- `apps/web-main/src/lib/session-transport.ts`（改：Agent 级 watch + 生命周期回调）
- `apps/web-main/src/lib/session-transport.spec.ts`（改）

**Interfaces:**

Produces（T19 复用同一份逻辑，D9 的「上层处理逻辑一份」落点）：

```ts
type SessionListEvent =
  | { type: "created"; session: SessionSummary }
  | { type: "deleted"; sessionId: string }
  | { type: "renamed"; sessionId: string; title: string }
  | { type: "status_changed"; sessionId: string; status: SessionStatus };

/** 把一条生命周期事件应用到会话列表，返回新数组（不可变）。不认识的会话：created 插入，其余忽略。 */
function applySessionListEvent(list: SessionSummary[], evt: SessionListEvent): SessionSummary[];

/** 把 relay/ws-events 的原始 (event, payload) 归一成 SessionListEvent；不是生命周期事件返 null。 */
function toSessionListEvent(event: string, payload: unknown): SessionListEvent | null;

// SessionTransport 契约扩展
interface SessionTransport {
  /** 开始观察该 Agent 的会话生命周期（Agent 级 watch）。返回 unwatch。 */
  watchAgent?: (onEvent: (evt: SessionListEvent) => void) => () => void;
}
```

Consumes：T2 的事件常量与类型、T11 的 tracker（生命周期帧同样以 `AgentRunFrame{watchId}` 到达）。

### 步骤

- [ ] **写失败测试** `packages/web-common/src/session/session-list-events.spec.ts`：

```ts
import { SESSION_LIFECYCLE_EVENTS, SESSION_STATUS_EVENTS } from "@meshbot/types-agent";
import { applySessionListEvent, toSessionListEvent } from "./session-list-events";

const s = (id: string, over = {}) => ({
  id, title: `会话${id}`, status: "idle" as const, pinned: false, pinnedAt: null,
  titleGenerated: false, modelConfigId: null, agentId: "a1",
  createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z", ...over,
});

describe("toSessionListEvent", () => {
  it("识别四类生命周期事件", () => {
    expect(toSessionListEvent(SESSION_LIFECYCLE_EVENTS.created, { agentId: "a1", session: s("s1") }))
      .toEqual({ type: "created", session: s("s1") });
    expect(toSessionListEvent(SESSION_LIFECYCLE_EVENTS.deleted, { agentId: "a1", sessionId: "s1" }))
      .toEqual({ type: "deleted", sessionId: "s1" });
    expect(toSessionListEvent(SESSION_LIFECYCLE_EVENTS.renamed, { agentId: "a1", sessionId: "s1", title: "新" }))
      .toEqual({ type: "renamed", sessionId: "s1", title: "新" });
    expect(toSessionListEvent(SESSION_STATUS_EVENTS.changed, { agentId: "a1", sessionId: "s1", status: "running" }))
      .toEqual({ type: "status_changed", sessionId: "s1", status: "running" });
  });

  it("推理帧等其它事件返 null", () => {
    expect(toSessionListEvent("run.chunk", { sessionId: "s1" })).toBeNull();
  });

  it("payload 形状不符返 null，不抛（relay 透传 unknown）", () => {
    expect(toSessionListEvent(SESSION_LIFECYCLE_EVENTS.deleted, "乱七八糟")).toBeNull();
    expect(toSessionListEvent(SESSION_LIFECYCLE_EVENTS.created, { agentId: "a1" })).toBeNull();
  });
});

describe("applySessionListEvent", () => {
  it("created 插到列表最前（新会话在顶）", () => {
    expect(applySessionListEvent([s("s1")], { type: "created", session: s("s2") }).map((x) => x.id))
      .toEqual(["s2", "s1"]);
  });

  it("created 重复 id 不产生重复行（幂等）", () => {
    expect(applySessionListEvent([s("s1")], { type: "created", session: s("s1") }).map((x) => x.id))
      .toEqual(["s1"]);
  });

  it("deleted 移除", () => {
    expect(applySessionListEvent([s("s1"), s("s2")], { type: "deleted", sessionId: "s1" }).map((x) => x.id))
      .toEqual(["s2"]);
  });

  it("renamed 改标题并置 titleGenerated", () => {
    const out = applySessionListEvent([s("s1")], { type: "renamed", sessionId: "s1", title: "新名" });
    expect(out[0]).toMatchObject({ title: "新名", titleGenerated: true });
  });

  it("status_changed 改状态", () => {
    const out = applySessionListEvent([s("s1")], { type: "status_changed", sessionId: "s1", status: "running" });
    expect(out[0].status).toBe("running");
  });

  it("列表里没有的会话：非 created 事件被忽略（不凭空造行）", () => {
    const list = [s("s1")];
    expect(applySessionListEvent(list, { type: "renamed", sessionId: "不存在", title: "x" })).toEqual(list);
    expect(applySessionListEvent(list, { type: "deleted", sessionId: "不存在" })).toEqual(list);
  });

  it("不可变：不修改传入数组", () => {
    const list = [s("s1")];
    applySessionListEvent(list, { type: "renamed", sessionId: "s1", title: "新" });
    expect(list[0].title).toBe("会话s1");
  });
});
```

- [ ] **跑挂**：`npx jest packages/web-common/src/session/session-list-events.spec.ts`。

- [ ] **最小实现** `packages/web-common/src/session/session-list-events.ts`：

```ts
import {
  SESSION_LIFECYCLE_EVENTS,
  SESSION_STATUS_EVENTS,
  SessionCreatedEventSchema,
  SessionDeletedEventSchema,
  SessionRenamedEventSchema,
  SessionStatusChangedEventSchema,
  type SessionStatus,
  type SessionSummary,
} from "@meshbot/types-agent";

/**
 * 归一后的会话列表变更事件（spec D9「统一事件契约」的前端形态）。
 *
 * **本地与远程共用同一份**：本地 Agent 的生命周期事件来自 `ws/events` 信封，
 * 远程 Agent 的来自 relay 的 Agent 级 watch 镜像帧——两条传输、一套模型，
 * 上层（会话列表 atom / react-query 缓存）只认这一个类型，不必知道 Agent 是
 * 本地还是远程。
 */
export type SessionListEvent =
  | { type: "created"; session: SessionSummary }
  | { type: "deleted"; sessionId: string }
  | { type: "renamed"; sessionId: string; title: string }
  | { type: "status_changed"; sessionId: string; status: SessionStatus };

/**
 * 把原始 `(event, payload)` 归一成 {@link SessionListEvent}；不是生命周期
 * 事件（如推理帧）返回 null。
 *
 * payload 走 zod 校验而非裸断言：relay 那条路上它是 `unknown` 透传，形状不符
 * 时返回 null 静默跳过，绝不让一条畸形帧把整个列表更新链路打断。
 */
export function toSessionListEvent(
  event: string,
  payload: unknown,
): SessionListEvent | null {
  if (event === SESSION_LIFECYCLE_EVENTS.created) {
    const p = SessionCreatedEventSchema.safeParse(payload);
    return p.success ? { type: "created", session: p.data.session } : null;
  }
  if (event === SESSION_LIFECYCLE_EVENTS.deleted) {
    const p = SessionDeletedEventSchema.safeParse(payload);
    return p.success ? { type: "deleted", sessionId: p.data.sessionId } : null;
  }
  if (event === SESSION_LIFECYCLE_EVENTS.renamed) {
    const p = SessionRenamedEventSchema.safeParse(payload);
    return p.success
      ? { type: "renamed", sessionId: p.data.sessionId, title: p.data.title }
      : null;
  }
  if (event === SESSION_STATUS_EVENTS.changed) {
    const p = SessionStatusChangedEventSchema.safeParse(payload);
    return p.success
      ? { type: "status_changed", sessionId: p.data.sessionId, status: p.data.status }
      : null;
  }
  return null;
}

/**
 * 把一条生命周期事件应用到会话列表，返回**新数组**（不可变，直接喂 React
 * state / jotai atom）。
 *
 * 语义细节：
 * - `created` 插到最前（新会话在顶，与列表的 updatedAt 倒序一致），同 id 幂等
 *   （relay 重连补发 + 本地事件可能各来一次）。
 * - 其余三类对**列表里没有的会话**一律忽略：不凭空造一行残缺数据——观察者
 *   可能只加载了部分会话（分页/筛选），也可能这条会话属于别的 Agent。
 */
export function applySessionListEvent(
  list: SessionSummary[],
  evt: SessionListEvent,
): SessionSummary[] {
  if (evt.type === "created") {
    if (list.some((s) => s.id === evt.session.id)) return list;
    return [evt.session, ...list];
  }
  if (evt.type === "deleted") {
    if (!list.some((s) => s.id === evt.sessionId)) return list;
    return list.filter((s) => s.id !== evt.sessionId);
  }
  if (!list.some((s) => s.id === evt.sessionId)) return list;
  return list.map((s) => {
    if (s.id !== evt.sessionId) return s;
    if (evt.type === "renamed") {
      return { ...s, title: evt.title, titleGenerated: true };
    }
    return { ...s, status: evt.status };
  });
}
```

- [ ] **跑过**：`npx jest packages/web-common/src/session/session-list-events.spec.ts` → 10 passed。
- [ ] **导出**：`packages/web-common/src/session/index.ts` 追加 `applySessionListEvent` / `toSessionListEvent` / `type SessionListEvent`。
- [ ] **约束自检**：`grep -rn "jotai\|next-intl\|apiClient\|next/navigation" packages/web-common/src/session/session-list-events.ts` → 零命中。

- [ ] **写失败测试**（web-main Agent 级 watch）——追加到 `apps/web-main/src/lib/session-transport.spec.ts`：

```ts
describe("web-main：Agent 级 watch", () => {
  it("watchAgent 发出 agent.watch.start（scope=agent，无 sessionId）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchAgent!(() => {});
    const [, body] = fakeSocket.emitted.find(([e]) => e === IM_WS_EVENTS.agentWatchStart)!;
    expect(body).toMatchObject({ targetAgentId: "cloud-a1", scope: "agent" });
    expect(body).not.toHaveProperty("sessionId");
  });

  it("生命周期镜像帧归一后回调（缺口 ② 的前端落点）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: unknown[] = [];
    t.watchAgent!((e) => seen.push(e));
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, { watchId, ok: true, inflight: null });
    fakeSocket.fire(IM_WS_EVENTS.agentRunFrame, {
      watchId, requesterDeviceId: "user:x", seq: 1, sessionId: "s9",
      event: SESSION_LIFECYCLE_EVENTS.created,
      payload: { agentId: "local-a1", session: { id: "s9", title: "远程建的", status: "running", pinned: false, pinnedAt: null, titleGenerated: false, modelConfigId: null, agentId: "local-a1", createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z" } },
    });
    expect(seen).toEqual([{ type: "created", session: expect.objectContaining({ id: "s9" }) }]);
  });

  it("非生命周期帧不触发回调", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: unknown[] = [];
    t.watchAgent!((e) => seen.push(e));
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, { watchId, ok: true, inflight: null });
    fakeSocket.fire(IM_WS_EVENTS.agentRunFrame, {
      watchId, requesterDeviceId: "user:x", seq: 1, sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk, payload: { sessionId: "s1" },
    });
    expect(seen).toEqual([]);
  });

  it("unwatch 释放 Agent 级通道", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const un = t.watchAgent!(() => {});
    const watchId = watchIdOfLastStart();
    un();
    expect(fakeSocket.emitted).toContainEqual([IM_WS_EVENTS.agentWatchStop, { watchId }]);
  });
});
```

- [ ] **最小实现**——`session-transport.ts` 加 `watchAgent`：与 `watchSession` 共用 `startWatch`（多一个 `scope` 参数），受理后 `runs.registerWatch(watchId, "")`（Agent 级没有单一 sessionId，用空串占位，帧照样按 watchId 认领）；`onRunFrame` 里对 Agent 级 watchId 的帧走 `toSessionListEvent` 归一后调回调，非生命周期事件丢弃。

  > **D6 抑制不适用于 Agent 级**：`hasActiveStreamFor("")` 恒为 false，天然不抑制——正确，生命周期事件不会与自己发起的 run 流重复。

  - 调用方接线：Agent 详情/会话列表页在 remote 分支 `useEffect` 里调 `transport.watchAgent?.(evt => setSessions(list => applySessionListEvent(list, evt)))`，cleanup 调 unwatch。定位：

```bash
grep -rn "listSessions()" apps/web-main/src --include="*.tsx" | head
```

- [ ] **跑过**：`npx jest apps/web-main/src/lib/session-transport.spec.ts 2>&1 | tail -20` → 全绿。
- [ ] **构建**：`pnpm --filter @meshbot/web-main build 2>&1 | tail -20` → `Compiled successfully`。
- [ ] **围栏 + 类型**：`pnpm typecheck 2>&1 | tail -20 && pnpm check 2>&1 | tail -30` → 全绿。
- [ ] **commit**：`feat(web-main): Agent 级观察通道接线，会话生命周期实时镜像到列表`

### ⭐ 交付点 B 手工验证清单

1. 浏览器 web-main 进入设备 B 的 Agent（会话列表可见）。
2. 在设备 B 本机 web-agent **新建**一个会话。
3. **期望**：web-main 的会话列表**立即**多出这一行，无需刷新（修缺口 ②）。
4. 在设备 B 本机**改名**该会话。
5. **期望**：web-main 列表标题实时改变。
6. 在设备 B 本机**删除**该会话。
7. **期望**：web-main 列表该行实时消失。
8. 从 web-main **远程发起**一个新会话（create 模式）。
9. **期望**：设备 B 本机 web-agent 的侧栏**立即**出现这个会话（反向也通，因为设备 B 本机走的是 `ws/events` 那条既有路径 + T13 新补的发射点）。

---

## Task 16：HITL watchId 寻址 + 先到先得

**Files:**
- `libs/types/src/im/im.schema.ts`（改：`AgentRunControlSchema` 的 `streamId` 转可选 + 加 `watchId` + refine）
- `libs/types/src/im/agent-run-control.schema.spec.ts`（改：补双寻址断言）
- `apps/server-agent/src/errors/agent.error-codes.ts`（改：新增 `HITL_ALREADY_ANSWERED = 3019`）
- `apps/server-agent/i18n/{zh,en}/*.json`（改：补 i18n key）
- `apps/server-agent/src/services/remote-run-registry.service.ts`（改：加 watchId 绑定）
- `apps/server-agent/src/services/remote-run-registry.service.spec.ts`（改）
- `apps/server-agent/src/services/remote-run-control.service.ts`（改：watchId 寻址 + 先到先得）
- `apps/server-agent/src/services/remote-run-control.service.spec.ts`（改）
- `apps/server-main/src/ws/im.gateway.ts`（改：`handleAgentRunControl` 支持 watchId 路由）
- `apps/server-main/src/ws/im.gateway.spec.ts`（改）

**Interfaces:**

Produces：

```ts
// 错误码（check:error-code 要求唯一 + 无 gap；当前最大 3018）
HITL_ALREADY_ANSWERED: { code: 3019, message: "im.hitlAlreadyAnswered", httpStatus: 409 }

// AgentRunControlInput：streamId 与 watchId 二选一必填（同 AgentRunFrame 的双寻址）
interface AgentRunControlInput {
  streamId?: string; watchId?: string; targetAgentId: string; sessionId: string;
  kind: "confirm" | "answer" | "interrupt";
  toolCallId?: string; decision?: "send" | "cancel"; content?: string; answers?: AgentRunAnswerItem[];
}

// RemoteRunRegistryService 扩展
bindWatch(watchId: string, sessionId: string): void;
unbindWatch(watchId: string): void;
sessionIdOfWatch(watchId: string): string | undefined;
```

Consumes：T4 的 `SessionWatchService.sessionIdOf`、`ConfirmationService.resolve`（**已返回 boolean，天然实现先到先得**，`confirmation.service.ts:59-66`）。

**关键点**：`interrupt` **不接受 watchId 寻址**——spec「不在本轮」明确「**打断仍限发起方**，观察者只能应答 HITL」。watchId 携带的 `kind:"interrupt"` 一律拒。

### 步骤

- [ ] **写失败测试（协议）**——追加到 `libs/types/src/im/agent-run-control.schema.spec.ts`：

```ts
describe("AgentRunControl 双寻址", () => {
  const base = { targetAgentId: "a1", sessionId: "s1", kind: "confirm" as const, toolCallId: "t1", decision: "send" as const };
  it("只带 streamId 通过", () => {
    expect(AgentRunControlSchema.safeParse({ ...base, streamId: "st1" }).success).toBe(true);
  });
  it("只带 watchId 通过（观察者应答）", () => {
    expect(AgentRunControlSchema.safeParse({ ...base, watchId: "w1" }).success).toBe(true);
  });
  it("都不带 / 都带 均被拒", () => {
    expect(AgentRunControlSchema.safeParse(base).success).toBe(false);
    expect(AgentRunControlSchema.safeParse({ ...base, streamId: "st1", watchId: "w1" }).success).toBe(false);
  });
  it("watchId 携带 interrupt 被拒（打断仍限发起方）", () => {
    expect(
      AgentRunControlSchema.safeParse({ targetAgentId: "a1", sessionId: "s1", kind: "interrupt", watchId: "w1" }).success,
    ).toBe(false);
  });
});
```

- [ ] **实现（协议）**——`im.schema.ts`：

```ts
export const AgentRunControlSchema = z
  .object({
    /** 自己发起的流；与 watchId 二选一必填。 */
    streamId: z.string().min(1).optional(),
    /**
     * 观察中的通道（Agent 级观察通道 D2：观察者也能应答 HITL）；与 streamId
     * 二选一必填。**不可携带 `kind:"interrupt"`**——打断权限仍限发起方
     * （spec「不在本轮」：观察者只能应答 HITL）。
     */
    watchId: z.string().min(1).optional(),
    targetAgentId: z.string().min(1),
    sessionId: z.string().min(1),
    kind: z.enum(["confirm", "answer", "interrupt"]),
    toolCallId: z.string().optional(),
    decision: z.enum(["send", "cancel"]).optional(),
    content: z.string().optional(),
    answers: z.array(AgentRunAnswerItemSchema).optional(),
  })
  .refine((v) => !!v.streamId !== !!v.watchId, {
    message: "streamId 与 watchId 二选一必填",
  })
  .refine((v) => !(v.watchId && v.kind === "interrupt"), {
    message: "观察者不可中断他人发起的 run（打断权限限发起方）",
    path: ["kind"],
  });
```

- [ ] **跑过**：`npx jest libs/types/src/im/agent-run-control.schema.spec.ts` → 全绿。

- [ ] **错误码**——`agent.error-codes.ts` 在 `MODEL_CONFIG_READONLY`（3018）之后追加：

```ts
  /**
   * HITL 卡片已被其它端应答（Agent 级观察通道 D3 先到先得）。
   * `ConfirmationService` 是单例挂起核心，天然只 resolve 一次；晚到的应答
   * 收到本错误，客户端据此把卡片置为**已完成**而非弹错误框。
   */
  HITL_ALREADY_ANSWERED: {
    code: 3019,
    message: "im.hitlAlreadyAnswered",
    httpStatus: 409,
  },
```

- [ ] **i18n**：在 `apps/server-agent/i18n/zh/im.json` / `en/im.json` 补 `hitlAlreadyAnswered`（zh：「该确认已由其他端应答」；en：`This confirmation was already answered on another client.`）。
- [ ] **围栏**：`pnpm check:error-code 2>&1 | tail -10` → 通过（唯一 + 无 gap）。

- [ ] **写失败测试（注册表）**——`remote-run-registry.service.spec.ts` 追加：

```ts
  it("bindWatch / sessionIdOfWatch / unbindWatch", () => {
    const r = new RemoteRunRegistryService();
    r.bindWatch("w1", "s1");
    expect(r.sessionIdOfWatch("w1")).toBe("s1");
    r.unbindWatch("w1");
    expect(r.sessionIdOfWatch("w1")).toBeUndefined();
  });

  it("watchId 与 streamId 两套映射互不干扰（同名 id 也不串）", () => {
    const r = new RemoteRunRegistryService();
    r.bind("x", "会话A");
    r.bindWatch("x", "会话B");
    expect(r.sessionIdOf("x")).toBe("会话A");
    expect(r.sessionIdOfWatch("x")).toBe("会话B");
  });
```

- [ ] **实现（注册表）**——加一张独立 Map（**不与 streamId 共用**：两者语义与生命周期不同，共用会让 unbind 互相误清）：

```ts
  /**
   * watchId → sessionId（Agent 级观察通道 D2：观察者也能应答 HITL）。
   * 与 `streamToSession` **分表**：streamId 是「我发起的一次性流」，watchId 是
   * 「我观察的常驻通道」，生命周期完全不同；共用一张表会让某一侧的 unbind
   * 误清另一侧（且 id 空间无交集保证）。
   */
  private readonly watchToSession = new Map<string, string>();

  /** 登记一条观察通道的 watchId→sessionId 映射（`AgentWatchInboundService` 受理时调）。 */
  bindWatch(watchId: string, sessionId: string): void {
    this.watchToSession.set(watchId, sessionId);
  }

  /** 移除观察通道映射（unwatch / idle 拆除时调）。 */
  unbindWatch(watchId: string): void {
    this.watchToSession.delete(watchId);
  }

  /** 反查 watchId 对应的 sessionId；未登记返 undefined。 */
  sessionIdOfWatch(watchId: string): string | undefined {
    return this.watchToSession.get(watchId);
  }
```

  `AgentWatchInboundService`（T6）的 session scope 受理分支追加 `this.registry.bindWatch(watchId, sessionId)`，stop 分支追加 `this.registry.unbindWatch(watchId)`；`SessionWatchService` 的 idle 拆除回调里也要 `unbindWatch`（**否则 idle 拆了转发器、watchId→sessionId 映射还在，HITL 会对一个已无观察通道的 watchId 放行**）——给 `SessionWatchService` 加一个可选的 `onWatchReleased?: (watchId: string) => void` 构造回调，module 里接上 `registry.unbindWatch`，并补测。

- [ ] **写失败测试（control）**——`remote-run-control.service.spec.ts` 追加：

```ts
  it("watchId 寻址：校验通过则 resolve（观察者应答生效，D2）", () => {
    const { svc, registry, confirmation } = mk();
    registry.sessionIdOfWatch.mockReturnValue("s1");
    confirmation.resolve.mockReturnValue(true);
    svc.onAgentRunControl({
      cloudUserId: "u1",
      forwarded: { watchId: "w1", targetAgentId: "a1", sessionId: "s1", kind: "confirm", toolCallId: "t1", decision: "send", requesterDeviceId: "user:x", localAgentId: "a1" },
    } as never);
    expect(confirmation.resolve).toHaveBeenCalledWith("u1:s1:t1", { action: "send", content: undefined });
  });

  it("watchId 与 sessionId 绑定不符 → 拒（防跨会话越权 resolve）", () => {
    const { svc, registry, confirmation } = mk();
    registry.sessionIdOfWatch.mockReturnValue("别的会话");
    svc.onAgentRunControl({
      cloudUserId: "u1",
      forwarded: { watchId: "w1", targetAgentId: "a1", sessionId: "s1", kind: "confirm", toolCallId: "t1", decision: "send", requesterDeviceId: "user:x", localAgentId: "a1" },
    } as never);
    expect(confirmation.resolve).not.toHaveBeenCalled();
  });

  it("未登记的 watchId → 拒", () => {
    const { svc, registry, confirmation } = mk();
    registry.sessionIdOfWatch.mockReturnValue(undefined);
    svc.onAgentRunControl({
      cloudUserId: "u1",
      forwarded: { watchId: "野的", targetAgentId: "a1", sessionId: "s1", kind: "confirm", toolCallId: "t1", decision: "send", requesterDeviceId: "user:x", localAgentId: "a1" },
    } as never);
    expect(confirmation.resolve).not.toHaveBeenCalled();
  });

  it("先到先得：resolve 返 false（已被应答）→ 回 HITL_ALREADY_ANSWERED 给该端", () => {
    const { svc, registry, confirmation, relay } = mk();
    registry.sessionIdOfWatch.mockReturnValue("s1");
    confirmation.resolve.mockReturnValue(false);
    svc.onAgentRunControl({
      cloudUserId: "u1",
      forwarded: { watchId: "w1", targetAgentId: "a1", sessionId: "s1", kind: "confirm", toolCallId: "t1", decision: "send", requesterDeviceId: "user:x", localAgentId: "a1" },
    } as never);
    expect(relay.emitAgentWatchAccepted).not.toHaveBeenCalled();
    expect(relay.emitAgentRunEnd).not.toHaveBeenCalled();
    // 晚到应答的告知走 hitl_settled 关卡帧（Task 17），此处只断言未误 resolve、未崩
    expect(confirmation.resolve).toHaveBeenCalledTimes(1);
  });

  it("watchId 携带 interrupt → 拒（打断仍限发起方）", () => {
    const { svc, runner } = mk();
    svc.onAgentRunControl({
      cloudUserId: "u1",
      forwarded: { watchId: "w1", targetAgentId: "a1", sessionId: "s1", kind: "interrupt", requesterDeviceId: "user:x", localAgentId: "a1" },
    } as never);
    expect(runner.interrupt).not.toHaveBeenCalled();
  });

  it("streamId 路径行为零变化（回归）", () => {
    const { svc, registry, confirmation } = mk();
    registry.sessionIdOf.mockReturnValue("s1");
    confirmation.resolve.mockReturnValue(true);
    svc.onAgentRunControl({
      cloudUserId: "u1",
      forwarded: { streamId: "st1", targetAgentId: "a1", sessionId: "s1", kind: "confirm", toolCallId: "t1", decision: "send", requesterDeviceId: "d", localAgentId: "a1" },
    } as never);
    expect(confirmation.resolve).toHaveBeenCalledWith("u1:s1:t1", { action: "send", content: undefined });
  });
```

- [ ] **实现（control）**——`remote-run-control.service.ts` 把绑定校验抽成一步：

```ts
        if (forwarded.kind === "interrupt") {
          if (forwarded.watchId) {
            // 打断权限限发起方（spec「不在本轮」）：观察者只能应答 HITL。
            // 协议层 zod 已拒，这里是二次门控——relay 转发的是已解析对象，
            // 不能假设它一定过了 schema。
            this.logger.warn(`观察者尝试中断（watchId=${forwarded.watchId}），拒`);
            return;
          }
          this.runner.interrupt(forwarded.sessionId);
          return;
        }
        ...
        // 双寻址的绑定校验：streamId 走 streamToSession，watchId 走 watchToSession。
        // 两者语义一致——「这条控制帧声称要操作的 sessionId，确实是该 id 名下
        // 登记的那个会话」，防同账号内跨会话 resolve。
        const bound = forwarded.watchId
          ? this.registry.sessionIdOfWatch(forwarded.watchId)
          : this.registry.sessionIdOf(forwarded.streamId as string);
        if (bound !== forwarded.sessionId) {
          this.logger.warn(
            `远程 ${forwarded.kind} sessionId 与 ${forwarded.watchId ? "watchId" : "streamId"} 绑定不符，拒`,
          );
          return;
        }
        const key = ConfirmationService.key(cloudUserId, forwarded.sessionId, forwarded.toolCallId);
        const ok =
          forwarded.kind === "confirm"
            ? this.confirmation.resolve(key, {
                action: forwarded.decision ?? "cancel",
                content: forwarded.content,
              })
            : this.confirmation.resolve(key, { answers: forwarded.answers ?? [] });
        // 先到先得（D3）：ConfirmationService 是单例挂起核心，天然只 resolve
        // 一次——首个到达的应答返 true 并关卡，其余返 false。晚到方靠 Task 17
        // 的关卡广播帧把卡片置为已完成（不是弹错误框）。
        if (!ok) {
          this.logger.debug(
            `HITL 已由其它端应答（toolCallId=${forwarded.toolCallId}），本次忽略`,
          );
        }
```

- [ ] **实现（云端路由）**——`im.gateway.ts` 的 `handleAgentRunControl` 支持 watchId：

```ts
  @SubscribeMessage(IM_WS_EVENTS.agentRunControl)
  @UseGuards(WsAuthGuard)
  async handleAgentRunControl(
    @MessageBody() body: AgentRunControlInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const requester = this.requesterOf(client);
    // 双寻址（D2）：watchId 走 watchRoutes（观察者应答），streamId 走
    // agentRunRoutes（发起方控制）。两条路的鉴权语义一致——必须是登记该 id
    // 的 requester 本人（`sameRequester` 全等），否则视为越权/未知，静默拒。
    if (body.watchId) {
      const route = this.watchRoutes.get(body.watchId);
      if (!route || !this.sameRequester(route.requester, requester)) return;
      if (route.scope !== "session") return; // Agent 级 watch 不承载 HITL
      if (body.kind === "interrupt") return; // 打断限发起方
      this.server
        .to(`device:${route.targetDeviceId}`)
        .emit(IM_WS_EVENTS.agentRunControl, {
          ...body,
          requesterDeviceId: this.encodeRequester(requester),
          localAgentId: route.localAgentId,
        } satisfies AgentRunControlForwarded);
      return;
    }
    const route = this.agentRunRoutes.get(body.streamId as string);
    if (!route || !this.sameRequester(route.requester, requester)) return;
    // ...既有逻辑不变
  }
```

  对应云端测试：`it("watchId control 路由到目标设备")` / `it("他人的 watchId control 被拒")` / `it("Agent 级 watchId 的 control 被拒")` / `it("watchId + interrupt 被拒")`。

- [ ] **跑过**：

```bash
npx jest apps/server-agent/src/services/remote-run-control.service.spec.ts apps/server-agent/src/services/remote-run-registry.service.spec.ts apps/server-main/src/ws/im.gateway.spec.ts 2>&1 | tail -30
```
全绿（**读完整输出**）。

- [ ] **围栏**：`pnpm check 2>&1 | tail -30` → 全绿（`check:error-code` 重点看）。
- [ ] **commit**：`feat: HITL 支持 watchId 寻址与先到先得（新错误码 HITL_ALREADY_ANSWERED 3019）`

---

## Task 17：HITL 关卡广播

spec §D：「应答生效后，把「该卡片已由某端应答」作为一帧镜像给**全部观察者 + 本地 ws/session 房间**，各端据此把卡片置为已完成。」

**优雅落点**：新增一个 `SESSION_WS_EVENTS.runHitlSettled` 事件，走 EventEmitter2 发一次即可——`SessionGateway` 转本地房间、`SessionFrameForwarder`（在 `FORWARDED_SESSION_EVENTS` 里加上它）自动转给 per-run 发起方与全部观察者。**一次 emit，三条出口全覆盖，零额外路由代码。**

**Files:**
- `libs/types-agent/src/session.ts`（改：`SESSION_WS_EVENTS` 加 `runHitlSettled` + payload schema）
- `apps/server-agent/src/services/session-frame-forwarder.ts`（改：加入转发白名单）
- `apps/server-agent/src/ws/session.gateway.ts`（改：加 `@OnEvent` 转本地房间）
- `apps/server-agent/src/services/confirmation.service.ts`（改：resolve 成功后 emit）
- `apps/server-agent/src/services/confirmation.service.spec.ts`（改）
- `packages/web-common/src/session/use-session-stream.ts`（改：消费该事件把卡片置完成）
- 相关 spec

**Interfaces:**

Produces：

```ts
runHitlSettled: "run.hitl_settled"
const RunHitlSettledEventSchema = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  /** 应答来源：本机浏览器 / 远程发起方 / 观察者。前端可据此提示「已由其他端应答」。 */
  by: z.enum(["local", "remote", "observer"]),
});
```

### 步骤

- [ ] **写失败测试**：
  1. `libs/types-agent`：schema 形状 + 事件名。
  2. `confirmation.service.spec.ts`：`resolve` 成功 → emit 一次 `run.hitl_settled`；`resolve` 失败（已应答）→ **不 emit**。
  3. `session-frame-forwarder.spec.ts`：`run.hitl_settled` 在转发白名单里（emit 后 sink 收到）。
  4. `session.gateway.spec.ts`：`@OnEvent` 把该事件转到 `payload.sessionId` 房间。
  5. `use-session-stream`：收到该事件后对应 toolCallId 的卡片进入 settled 态、不再可点。

```ts
// confirmation.service.spec.ts 关键用例
it("resolve 成功 → 广播关卡帧（三条出口共用这一次 emit）", () => {
  const emitted: Array<[string, unknown]> = [];
  const svc = new ConfirmationService({ emit: (e, p) => emitted.push([e, p]) } as never);
  const p = svc.waitForDecision("u1:s1:t1", new AbortController().signal, 60_000);
  expect(svc.resolve("u1:s1:t1", { action: "send" }, { sessionId: "s1", toolCallId: "t1", by: "observer" })).toBe(true);
  expect(emitted).toEqual([
    [SESSION_WS_EVENTS.runHitlSettled, { sessionId: "s1", toolCallId: "t1", by: "observer" }],
  ]);
  return p;
});

it("resolve 失败（已被应答）→ 不广播（避免重复关卡帧）", () => {
  const emitted: Array<[string, unknown]> = [];
  const svc = new ConfirmationService({ emit: (e, p) => emitted.push([e, p]) } as never);
  expect(svc.resolve("不存在", { action: "send" }, { sessionId: "s1", toolCallId: "t1", by: "local" })).toBe(false);
  expect(emitted).toEqual([]);
});
```

- [ ] **实现**：
  - `SESSION_WS_EVENTS` 加 `runHitlSettled: "run.hitl_settled"` + schema。
  - `ConfirmationService` 注入 `EventEmitter2`，`resolve` 增加**可选**第三参 `meta?: { sessionId, toolCallId, by }`——不传则不广播（保留既有本地路径的调用点不改动的余地；本 Task 把三个调用点：本地 REST confirm/answer 控制器、`RemoteRunControlService` 的 streamId 分支、watchId 分支，分别传 `by: "local" | "remote" | "observer"`）。

```ts
  /**
   * 解锁某 key 的等待。key 不存在 → no-op 返回 false（**先到先得的判定点**：
   * 首个应答返 true 并关卡，晚到的返 false，Agent 级观察通道 D3）。
   *
   * @param meta 传入则在**成功解锁时**广播一帧 `run.hitl_settled`——一次 emit
   *   同时覆盖三条出口：`SessionGateway` 转本机 ws/session 房间、
   *   `SessionFrameForwarder` 转 per-run 发起方与**全部观察者**。各端据此把
   *   卡片置为已完成，而不是让晚到方看到一个永远点不动的卡（spec §D 关卡广播）。
   *   失败时**不**广播——卡早已被首个应答关掉，重复帧只会造成 UI 抖动。
   */
  resolve<T = ConfirmDecision>(
    key: string,
    decision: T,
    meta?: { sessionId: string; toolCallId: string; by: "local" | "remote" | "observer" },
  ): boolean {
    const fn = this.pending.get(key);
    if (!fn) return false;
    fn(decision);
    if (meta) {
      this.emitter.emit(SESSION_WS_EVENTS.runHitlSettled, meta satisfies RunHitlSettledEvent);
    }
    return true;
  }
```

  - `FORWARDED_SESSION_EVENTS` 追加 `SESSION_WS_EVENTS.runHitlSettled`（**加在数组末尾**，注释说明它是关卡广播帧）。
  - `session.gateway.ts` 按该文件既有 `@OnEvent` 范式加一个转发到 `payload.sessionId` 房间的方法。
  - `use-session-stream.ts` 加一条 `case SESSION_WS_EVENTS.runHitlSettled`：按 `toolCallId` 找到对应的 confirm/ask 卡片，标记为已完成（禁用按钮 + 显示「已由其他端应答」）。**该文案走 next-intl**，由调用方 labels 注入（web-common 不碰 i18n）。

- [ ] **注意 `ConfirmationService` 是单例命门**：`grep -rn "ConfirmationService" apps/server-agent/src --include="*.module.ts"` 确认**只 provide 一次**——重复 provide 会让 im_send / ask_question / 远程应答挂在不同实例上，resolve 永远找不到 pending（历史踩过的坑）。改构造签名后尤其要确认。

- [ ] **跑过**：

```bash
npx jest apps/server-agent/src/services/confirmation.service.spec.ts apps/server-agent/src/services/session-frame-forwarder.spec.ts apps/server-agent/src/ws/session.gateway.spec.ts packages/web-common/src/session 2>&1 | tail -30
```
全绿。

- [ ] **i18n**：`pnpm sync:locales --write` 后填 zh/en 实文案（zh：「已由其他端应答」；en：`Answered on another client`），再 `pnpm sync:locales` 确认 **missing=0**。
- [ ] **boot 验证**（改了 `ConfirmationService` 构造签名）：

```bash
pnpm --filter @meshbot/server-agent build \
  && timeout 60 node apps/server-agent/dist/main.js 2>&1 | tail -40
```
期望 `Nest application successfully started`。

- [ ] **围栏**：`pnpm check 2>&1 | tail -30` → 全绿。
- [ ] **commit**：`feat: HITL 关卡广播（run.hitl_settled 一次 emit 覆盖本地房间/发起方/全部观察者）`

---

## Task 18：server-agent 观察者代理层（web-agent 的 D4 对称）

web-agent 浏览器**不直连云端**，必须经自己的 server-agent 代理。本 Task 让 A 侧 server-agent 能作为观察者发起 watch，并把回流帧下发给本机浏览器。

**⚠️ 本 Task 是「避免与本地 ws/events 重复投递」的关键落点**——见下方两条分流规则。

**Files:**
- `apps/server-agent/src/cloud/remote-watch.service.ts`（新）
- `apps/server-agent/src/cloud/remote-watch.service.spec.ts`（新）
- `apps/server-agent/src/cloud/remote-run.service.ts`（改：`onFrame` 对 watchId 帧短路交给 `RemoteWatchService`）
- `apps/server-agent/src/controllers/remote-agent-session.controller.ts`（改：新增 watch/unwatch 端点）
- `libs/types-agent/src/remote-agent.events.ts`（改：新增 `remoteAgentSessionEvent` 信封 type）
- `apps/server-agent/src/ws/events.gateway.ts`（改：新增 `@OnEvent` 下发生命周期镜像）

**Interfaces:**

Produces：

```ts
// REST（web-agent 浏览器 → 本机 server-agent）
POST   /api/remote-agents/:agentId/watch   body: { scope: "agent" | "session", sessionId?: string }  → { watchId }
DELETE /api/remote-agents/:agentId/watch/:watchId                                                    → 204

// ws/events 信封新 type（Agent 级生命周期镜像下发浏览器）
REMOTE_AGENT_EVENTS.sessionEvent = "remote-agent.session_event"
interface RemoteAgentSessionEventPayload {
  /** 云端 Agent id（**不是**本地 agentId）——前端据此判定属于哪个远程 Agent 的视图。 */
  agentId: string;
  event: string;    // session.created / deleted / renamed / status_changed
  payload: unknown; // 对应事件的原 payload
}
```

**两条分流规则（重复投递防护，务必照做）**：

1. **Session 级观察帧**（推理帧）→ 复用既有的 `REMOTE_SHADOW_FRAME_EVENT` 桥（`remote-run.service.ts:183`）→ `SessionGateway` 按 `payload.sessionId` 转房间。web-agent 的远程会话视图本来就订阅这个 sessionId 的 ws/session 房间，**前端零改动即可实时**。
2. **Agent 级生命周期帧** → **绝不**重发成本地 `SESSION_LIFECYCLE_EVENTS.*`。那条总线上挂着 `AgentWatchMirrorService`（会把别人的事件当自己的再镜像出去，形成回环）与 `EventsGateway`（会让浏览器误以为是**本机**会话，插进本地列表）。必须包进**专属信封** `REMOTE_AGENT_EVENTS.sessionEvent`，带上**云端 agentId**，浏览器按 agentId 分流到对应的远程 Agent 视图。这与既有 `REMOTE_SHADOW_FRAME_EVENT` 不复用原始事件名是**同一个理由**（见其 JSDoc：「复用会把 B 会话的数据污染进 A 本地 SQLite」）。

### 步骤

- [ ] **写失败测试** `apps/server-agent/src/cloud/remote-watch.service.spec.ts`：

```ts
import { REMOTE_SHADOW_FRAME_EVENT } from "./remote-shadow.events";
import { IM_WS_EVENTS } from "@meshbot/types";
import {
  REMOTE_AGENT_EVENTS,
  SESSION_LIFECYCLE_EVENTS,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { RemoteWatchService } from "./remote-watch.service";

describe("RemoteWatchService（A 侧观察者代理）", () => {
  const mk = () => {
    const emitter = new EventEmitter2();
    const up: Array<[string, unknown]> = [];
    const relay = {
      emitAgentWatchStart: (_u: string, p: unknown) => up.push([IM_WS_EVENTS.agentWatchStart, p]),
      emitAgentWatchStop: (_u: string, p: unknown) => up.push([IM_WS_EVENTS.agentWatchStop, p]),
    };
    const svc = new RemoteWatchService(relay as never, emitter);
    return { svc, emitter, up };
  };
  const lifecyclePayload = {
    agentId: "远程本地id",
    session: {
      id: "s9", title: "远程建的", status: "running", pinned: false, pinnedAt: null,
      titleGenerated: false, modelConfigId: null, agentId: "远程本地id",
      createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z",
    },
  };

  it("startWatch 经 relay 上行 agent.watch.start 并返回 watchId", () => {
    const { svc, up } = mk();
    const { watchId } = svc.startWatch("u1", "cloud-a1", "session", "s1");
    expect(watchId).toBeTruthy();
    expect(up).toEqual([
      [IM_WS_EVENTS.agentWatchStart,
       { watchId, targetAgentId: "cloud-a1", scope: "session", sessionId: "s1" }],
    ]);
  });

  it("stopWatch 上行 agent.watch.stop 并解除登记", () => {
    const { svc, up } = mk();
    const { watchId } = svc.startWatch("u1", "cloud-a1", "agent");
    svc.stopWatch("u1", watchId);
    expect(up.at(-1)).toEqual([IM_WS_EVENTS.agentWatchStop, { watchId }]);
    expect(svc.owns(watchId)).toBe(false);
  });

  it("session 级回流帧 → 重发 REMOTE_SHADOW_FRAME_EVENT（复用既有影子渲染）", () => {
    const { svc, emitter } = mk();
    const shadow: unknown[] = [];
    emitter.on(REMOTE_SHADOW_FRAME_EVENT, (p) => shadow.push(p));
    const { watchId } = svc.startWatch("u1", "cloud-a1", "session", "s1");
    svc.onFrame({
      watchId, requesterDeviceId: "d", seq: 3, sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk, payload: { sessionId: "s1", delta: "远程输出" },
    } as never);
    expect(shadow).toEqual([
      { event: SESSION_WS_EVENTS.runChunk, payload: { sessionId: "s1", delta: "远程输出" } },
    ]);
  });

  it("agent 级回流帧 → 重发 REMOTE_AGENT_EVENTS.sessionEvent 信封（带云端 agentId）", () => {
    const { svc, emitter } = mk();
    const envelopes: unknown[] = [];
    emitter.on(REMOTE_AGENT_EVENTS.sessionEvent, (p) => envelopes.push(p));
    const { watchId } = svc.startWatch("u1", "cloud-a1", "agent");
    svc.onFrame({
      watchId, requesterDeviceId: "d", seq: 1, sessionId: "s9",
      event: SESSION_LIFECYCLE_EVENTS.created, payload: lifecyclePayload,
    } as never);
    expect(envelopes).toEqual([
      { agentId: "cloud-a1", event: SESSION_LIFECYCLE_EVENTS.created, payload: lifecyclePayload },
    ]);
  });

  it("agent 级回流帧【绝不】重发成本地 SESSION_LIFECYCLE_EVENTS（防污染本地列表 + 防镜像回环）", () => {
    const { svc, emitter } = mk();
    const local: string[] = [];
    for (const e of Object.values(SESSION_LIFECYCLE_EVENTS)) emitter.on(e, () => local.push(e));
    const { watchId } = svc.startWatch("u1", "cloud-a1", "agent");
    svc.onFrame({
      watchId, requesterDeviceId: "d", seq: 1, sessionId: "s9",
      event: SESSION_LIFECYCLE_EVENTS.created, payload: lifecyclePayload,
    } as never);
    expect(local).toEqual([]);
  });

  it("agent 级回流帧也不进影子桥（两条通道互不串）", () => {
    const { svc, emitter } = mk();
    const shadow: unknown[] = [];
    emitter.on(REMOTE_SHADOW_FRAME_EVENT, (p) => shadow.push(p));
    const { watchId } = svc.startWatch("u1", "cloud-a1", "agent");
    svc.onFrame({
      watchId, requesterDeviceId: "d", seq: 1, sessionId: "s9",
      event: SESSION_LIFECYCLE_EVENTS.created, payload: lifecyclePayload,
    } as never);
    expect(shadow).toEqual([]);
  });

  it("未登记 watchId 的帧被忽略", () => {
    const { svc, emitter } = mk();
    const shadow: unknown[] = [];
    emitter.on(REMOTE_SHADOW_FRAME_EVENT, (p) => shadow.push(p));
    svc.onFrame({
      watchId: "野的", requesterDeviceId: "d", seq: 1, sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk, payload: {},
    } as never);
    expect(shadow).toEqual([]);
  });

  it("带 streamId 的帧被忽略（那是 RemoteRunService 的活）", () => {
    const { svc, emitter } = mk();
    const shadow: unknown[] = [];
    emitter.on(REMOTE_SHADOW_FRAME_EVENT, (p) => shadow.push(p));
    svc.onFrame({
      streamId: "st1", requesterDeviceId: "d", seq: 1, sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk, payload: {},
    } as never);
    expect(shadow).toEqual([]);
  });

  it("watch_accepted{ok:true,inflight} → 经影子桥补一发 run.snapshot（D7 续上）", () => {
    const { svc, emitter } = mk();
    const shadow: Array<{ event: string; payload: unknown }> = [];
    emitter.on(REMOTE_SHADOW_FRAME_EVENT, (p) => shadow.push(p as never));
    const { watchId } = svc.startWatch("u1", "cloud-a1", "session", "s1");
    svc.onAccepted({
      watchId, ok: true,
      inflight: { messageId: "m1", content: "半截", reasoning: "", reasoningStartedAt: null, toolCalls: [], status: "streaming" },
    } as never);
    expect(shadow).toEqual([
      { event: SESSION_WS_EVENTS.runSnapshot,
        payload: { sessionId: "s1", messageId: "m1", content: "半截", reasoning: "", reasoningStartedAt: null, toolCalls: [] } },
    ]);
  });

  it("watch_accepted{ok:false} → 解除登记（不留悬挂）", () => {
    const { svc } = mk();
    const { watchId } = svc.startWatch("u1", "cloud-a1", "session", "s1");
    svc.onAccepted({ watchId, ok: false, reason: "offline" } as never);
    expect(svc.owns(watchId)).toBe(false);
  });

  it("relay 重连（IM_RELAY_EVENTS.connected）→ 全部 watch 自动重发（D5）", () => {
    const { svc, up } = mk();
    svc.startWatch("u1", "cloud-a1", "session", "s1");
    svc.startWatch("u1", "cloud-a1", "agent");
    up.length = 0;
    svc.onRelayConnected({ cloudUserId: "u1" } as never);
    const starts = up.filter(([e]) => e === IM_WS_EVENTS.agentWatchStart);
    expect(starts).toHaveLength(2);
    expect(starts.map(([, p]) => (p as { scope: string }).scope).sort()).toEqual(["agent", "session"]);
  });

  it("重连只重发本账号的 watch（多账号不串）", () => {
    const { svc, up } = mk();
    svc.startWatch("u1", "cloud-a1", "session", "s1");
    svc.startWatch("u2", "cloud-a9", "session", "s9");
    up.length = 0;
    svc.onRelayConnected({ cloudUserId: "u1" } as never);
    expect(up.filter(([e]) => e === IM_WS_EVENTS.agentWatchStart)).toHaveLength(1);
  });

  it("onModuleDestroy 清空全部登记", () => {
    const { svc } = mk();
    const { watchId } = svc.startWatch("u1", "cloud-a1", "session", "s1");
    svc.onModuleDestroy();
    expect(svc.owns(watchId)).toBe(false);
  });
});
```

> `REMOTE_SHADOW_FRAME_EVENT` 的实际导入路径以 `grep -rn "REMOTE_SHADOW_FRAME_EVENT" apps/server-agent/src` 为准（`remote-run.service.ts` 已在用）。`svc.onFrame` / `svc.onAccepted` / `svc.onRelayConnected` 三个方法在实现里挂 `@OnEvent`，测试直接调方法本体、不经 emitter，与 `remote-run.service.spec.ts` 的既有写法一致。

- [ ] **实现** `RemoteWatchService`（镜像 `RemoteRunService` 的结构：进程内 `Map<watchId, {targetAgentId, scope, sessionId}>` + `@OnEvent` 桥接 + `onModuleDestroy`）。要点：
  - `@OnEvent(IM_RELAY_EVENTS.agentRunFrame)` 里**只处理带 `watchId` 的帧**，带 `streamId` 的交给既有 `RemoteRunService`（两个服务都监听同一事件，各自按字段短路——`RemoteRunService.onFrame` 首行加 `if (frame.watchId) return;`）。
  - `@OnEvent(IM_RELAY_EVENTS.agentWatchAcceptedInbound)` 处理受理包：`ok:false` 解除登记；`ok:true` 且 session 级时把 `inflight` 经 `REMOTE_SHADOW_FRAME_EVENT` 合成 `run.snapshot` 帧下发（复用 T11 的 `inflightToSnapshotEvent` 逻辑——**但那是 web-common 的浏览器包，server-agent 不能 import**；在本服务内写一份等价的 10 行转换，注释指明与 web-common 版本同源，两处形状必须一致）。
  - `@OnEvent(IM_RELAY_EVENTS.connected)` 重连重 watch。

- [ ] **实现** REST 端点（Controller 保持瘦身，逻辑全在 Service；**Controller 禁止注入 Repository**）+ Swagger 完整声明（`@ApiOperation` / `@ApiOkResponse` 带 DTO 类型，遵循 `swagger-api-declaration` 规范）。
- [ ] **实现** `events.gateway.ts` 新增：

```ts
  /**
   * 远程 Agent 的会话生命周期镜像 → 信封投递给所属账号浏览器（Agent 级观察
   * 通道，修缺口 ②）。
   *
   * **专属信封而非复用本地 `session.created` 等事件名**：本地那条总线上挂着
   * `AgentWatchMirrorService`（会把收到的事件当本机事件再镜像出去 → 回环）与
   * 本网关的本地下发路径（浏览器会把远程会话插进**本机**列表）。故包进
   * `remote-agent.session_event` 信封并携带**云端 agentId**，浏览器按 agentId
   * 分流到对应远程 Agent 的视图——与 `REMOTE_SHADOW_FRAME_EVENT` 不复用原始
   * `SESSION_WS_EVENTS.*` 名是同一个理由。
   */
  @OnEvent(REMOTE_AGENT_EVENTS.sessionEvent)
  onRemoteAgentSessionEvent(payload: RemoteAgentSessionEventPayload): void {
    this.emitEnvelope(REMOTE_AGENT_EVENTS.sessionEvent, payload);
  }
```

- [ ] **跑过**：`npx jest apps/server-agent/src/cloud/remote-watch.service.spec.ts apps/server-agent/src/cloud/remote-run.service.spec.ts apps/server-agent/src/ws/events.gateway.spec.ts 2>&1 | tail -30` → 全绿。
- [ ] **围栏**：`pnpm check:repo && pnpm check:dead 2>&1 | tail -20` → 全绿（Controller 未注入 Repository）。
- [ ] **boot 验证**：`pnpm --filter @meshbot/server-agent build && timeout 60 node apps/server-agent/dist/main.js 2>&1 | tail -40` → 启动成功。
- [ ] **commit**：`feat(server-agent): 观察者代理层（session 帧走影子桥、agent 生命周期走专属信封防重复投递）`

---

## Task 19：web-agent 观察者接线（补齐 D4 对称）

**Files:**
- `apps/web-agent/src/lib/session-transport.ts`（改：远程工厂加 `watchSession` / `watchAgent`，走 REST 代理）
- `apps/web-agent/src/hooks/use-global-events.ts`（改：**追加**一个 handler，别覆盖既有 3 个）
- `apps/web-agent/src/hooks/use-global-events.spec.ts`（改）
- `apps/web-agent/src/rest/remote-agents.ts`（改：watch/unwatch 客户端）

**Interfaces:**

Consumes：T18 的 REST 端点与 `REMOTE_AGENT_EVENTS.sessionEvent` 信封、T15 的 `toSessionListEvent` / `applySessionListEvent`（**与 web-main 用同一份**，D9 落点）。

### 步骤

- [ ] **写失败测试**——`use-global-events.spec.ts` 追加：

```ts
it("dispatchGlobalEvent 分发 remote-agent.session_event 到 onRemoteAgentSessionEvent", () => {
  const h = makeHandlers();
  dispatchGlobalEvent(
    { type: REMOTE_AGENT_EVENTS.sessionEvent, ts: 1,
      payload: { agentId: "cloud-a1", event: SESSION_LIFECYCLE_EVENTS.created, payload: { agentId: "local-a1", session: { id: "s9" } } } },
    h,
  );
  expect(h.onRemoteAgentSessionEvent).toHaveBeenCalledWith({
    agentId: "cloud-a1",
    event: SESSION_LIFECYCLE_EVENTS.created,
    payload: expect.anything(),
  });
});

it("既有 3 个 handler 仍各自生效（不被覆盖）", () => {
  const h = makeHandlers();
  dispatchGlobalEvent({ type: SESSION_STATUS_EVENTS.changed, ts: 1, payload: { agentId: "a", sessionId: "s", status: "idle" } }, h);
  dispatchGlobalEvent({ type: REMOTE_AGENT_EVENTS.registryChanged, ts: 1, payload: {} }, h);
  dispatchGlobalEvent({ type: AGENT_EVENTS.changed, ts: 1, payload: {} }, h);
  expect(h.onSessionStatusChanged).toHaveBeenCalled();
  expect(h.onRemoteAgentsChanged).toHaveBeenCalled();
  expect(h.onAgentChanged).toHaveBeenCalled();
});
```

- [ ] **实现**：
  - `GlobalEventHandlers` 接口**追加**（不改既有字段）：

```ts
  /**
   * 远程 Agent 的会话生命周期镜像（Agent 级观察通道）。与
   * `onSessionStatusChanged`（本机会话）分开：payload 里的 agentId 是**云端**
   * Agent id，落到远程 Agent 视图的会话列表，不能混进本机列表。
   */
  onRemoteAgentSessionEvent: (p: RemoteAgentSessionEventPayload) => void;
```

  - `dispatchGlobalEvent` 追加一个 `case REMOTE_AGENT_EVENTS.sessionEvent`（**加在 default 之前，别动既有 case**）。
  - `useGlobalEvents` 的 handlers 对象追加实现：把 `toSessionListEvent(p.event, p.payload)` 归一后更新对应远程 Agent 的会话列表缓存（`queryClient.setQueryData([...remoteSessionsQueryKey, p.agentId], list => applySessionListEvent(list ?? [], evt))`）。
  - `onConnect` 补拉：追加远程会话列表的 invalidate（断线期间的镜像帧会丢，重连兜底——照既有 `onConnect` 的三条 invalidate 的注释理由）。
  - `session-transport.ts` 远程工厂加 `watchSession` / `watchAgent`：调 T18 的 REST 端点拿 watchId，unwatch 调 DELETE。**推理帧不需要前端额外处理**——它们经影子桥已进了 ws/session 房间，既有订阅路径直接收到。

- [ ] **跑过**：`npx jest apps/web-agent/src/hooks/use-global-events.spec.ts 2>&1 | tail -20` → 全绿。
- [ ] **构建 + 清理（环境铁律）**：

```bash
pnpm --filter @meshbot/web-agent build 2>&1 | tail -20 && rm -rf apps/web-agent/.next
```
期望 `Compiled successfully`。**只删 `.next`，绝不删 `out`**（server-agent 同源伺服要它）。

- [ ] **i18n**：`pnpm sync:locales --write` 后填实文案，`pnpm sync:locales` 确认 **missing=0**。
- [ ] **围栏 + 类型**：`pnpm typecheck 2>&1 | tail -20 && pnpm check 2>&1 | tail -30` → 全绿。
- [ ] **commit**：`feat(web-agent): 观察者接线补齐 D4 对称（生命周期信封分发 + watch REST 代理）`

---

## Task 20：终验 + 双机冒烟

**Files:** 无代码改动（只跑验证；发现问题回到对应 Task 修）。

### 步骤

- [ ] **全量单测**：

```bash
pnpm test 2>&1 | tee /tmp/watch-final-test.log | tail -40
```
**读完整日志**（`/tmp/watch-final-test.log`），与本分支起点基线对比，**零新增失败**。已知预存在失败（见记忆）：`libs/agent` vitest 9 个 + e2e/boot 基础设施若干——判回归要 **diff 失败集合**，不是看总数。

- [ ] **libs/agent vitest**（本轮未改，确认基线未动）：

```bash
pnpm --filter @meshbot/lib-agent test 2>&1 | tail -20
```

- [ ] **类型**：`pnpm typecheck 2>&1 | tail -20` → 全绿。
- [ ] **围栏（CI 级）**：`pnpm check:strict 2>&1 | tail -40` → 全部 strict 模式通过。
- [ ] **i18n**：`pnpm sync:locales 2>&1 | tail -10` → **missing=0**。
- [ ] **格式**：`pnpm lint 2>&1 | tail -20 && pnpm format` → 无残留问题。
- [ ] **三端构建**：

```bash
pnpm --filter @meshbot/server-agent build 2>&1 | tail -5
pnpm --filter @meshbot/server-main build 2>&1 | tail -5
pnpm --filter @meshbot/web-main build 2>&1 | tail -5
pnpm --filter @meshbot/web-agent build 2>&1 | tail -5 && rm -rf apps/web-agent/.next
```

- [ ] **boot 验证（两个后端）**：

```bash
timeout 60 node apps/server-agent/dist/main.js 2>&1 | tail -40
timeout 60 node apps/server-main/dist/main.js 2>&1 | tail -40
```
均期望 `Nest application successfully started`，无 `Nest can't resolve dependencies`。

### 双机冒烟清单（人工，需两台设备 + 一个浏览器）

前置：设备 A、设备 B 登录同一账号；设备 B 有一个 `remote_enabled` 的 Agent；浏览器打开 web-main。

**① 推理帧镜像（修缺口 ①）**
- [ ] B 本机发起 run → web-main 打开同一会话 → 实时看到流式输出。
- [ ] web-main **中途**进入正在跑的会话 → 立刻渲染半截输出（inflight 续上，D7）。
- [ ] B 本机继续第二轮 → web-main **无需刷新**继续实时（**跨多轮存活，本设计关键差异**）。
- [ ] A 设备 web-agent 也打开同一会话 → 同样实时（D4 对称）。
- [ ] B 的 run 触发 `dispatch_subagent` → 观察者能看到子代理过程流（`allowedSessions` 未丢）。

**② 会话生命周期（修缺口 ②）**
- [ ] B 本机新建会话 → web-main 与 A 设备的会话列表**立即**出现该行。
- [ ] B 本机改名 → 两端标题实时变。
- [ ] B 本机删除 → 两端该行实时消失。
- [ ] A 设备**远程**给 B 建会话 → B 本机侧栏立即出现（反向也通）。
- [ ] 会话开跑/跑完 → 两端「运行中」绿点实时亮/灭。

**③ HITL（D2/D3）**
- [ ] B 的 run 触发工具确认卡 → **观察者端**（web-main）点确认 → 生效，B 继续跑。
- [ ] 两端**同时**点确认 → 只有一个生效；另一端卡片变为**已完成**（不是错误弹窗）。
- [ ] 关卡帧到达全部端：B 本机、A 设备、web-main 三处卡片都置为已完成。
- [ ] 观察者尝试**中断**他人发起的 run → 被拒（打断仍限发起方）。

**④ 泄漏防护（本设计最需防的点）**
- [ ] 观察者关页签 → 云端日志显示该 socket 的 watch 路由被清 + 设备收到 stop（防线 2）。
- [ ] 被观察设备 B 拔网线/退出 → 云端清该设备全部 watch 路由，观察者退化为不实时（防线 3）。
- [ ] 观察者主动离开会话 → 显式 unwatch，设备侧 5 分钟后日志出现 `会话观察通道 idle 拆除`（防线 1 + 4）。
- [ ] 反复刷新观察者页面 10 次 → 设备侧 EventEmitter2 监听器数**不累积**（idle 宽限期复用同一转发器）。
- [ ] 长跑 30 分钟无观察者 → 云端 `watchRoutes.size` 归零（idle 清扫生效）。

**⑤ 权限与隔离**
- [ ] 用另一个账号的 watchId 尝试 watch → 被拒。
- [ ] 关掉 B 上某 Agent 的「允许远程」→ 已有观察者收到拒绝 / 新 watch 被拒。
- [ ] 拿 remote_enabled 的 Agent X 当跳板、watch 归属 Agent Y 的会话 → 被拒（`session.agentId === agent.id` 校验）。
- [ ] 设备离线时 watch → 观察者收到明确的 `offline` 提示（**不静默**）。

**⑥ D6 抑制**
- [ ] 同一客户端既发起 run 又观察同一会话 → 消息**不出现双份**。

- [ ] **commit**（若终验有修补）：`fix: Agent 级观察通道终验修补`
- [ ] **收尾**：走 `superpowers:finishing-a-development-branch` 决定合并方式。

---

## 附：spec 覆盖对照（自审用）

| spec 章节 | 落点 Task |
|---|---|
| §A 协议层（生命周期 4 事件 / watch 控制 4 事件 / AgentRunFrame watchId 寻址） | T1、T2 |
| §B 云端路由（watchRoutes / agentWatchers / sessionWatchers / 四路清理） | T8、T9、T10 |
| §C1 会话生命周期镜像器 | T13（事件源）、T14（镜像器） |
| §C2 会话级常驻转发器（allowedSessions 保留 / 跨多轮存活 / idle / inflight） | T3、T4、T6 |
| §C 取舍（设备只镜像一份，云端 fan-out） | T4、T9、T14 |
| §D HITL（watchId 绑定 / control 寻址 / 先到先得 / 关卡广播） | T16、T17 |
| §E 对称客户端（web-common 共享 / 双 transport / tracker 双认 / D6 抑制） | T11、T12、T15、T18、T19 |
| 数据流：进入 Agent | T8（登记）、T14（镜像）、T15/T19（前端应用） |
| 数据流：打开会话 | T4/T6（inflight）、T11/T12（续上渲染） |
| 数据流：观察者应答 HITL | T16、T17 |
| 数据流：离开 | T4（idle）、T8（unwatch）、T12（unwatch 调用） |
| 错误处理：relay 断 / 重连重 watch | T12（重连重 watch）、T18（server-agent 侧重连） |
| 错误处理：无权 watch | T8（云端鉴权）、T6（设备二次门控） |
| 错误处理：设备离线明确失败 | T8 |
| 错误处理：晚到 HITL 应答 | T16（错误码）、T17（关卡帧置完成） |
| 错误处理：idle 泄漏防护 | T4（设备 idle）、T10（云端四路 + idle 清扫） |
| 测试：协议 schema | T1、T2 |
| 测试：云端 fan-out + 三表一致 + 四路清理各自单测 | T9、T10 |
| 测试：生命周期镜像（有/无观察者） | T14 |
| 测试：会话级转发器（首/末观察者、跨多轮、allowedSessions、idle） | T3、T4 |
| 测试：HITL（生效/先到先得/关卡广播/无权拒） | T16、T17 |
| 测试：续上（中途拿 inflight） | T11、T12 |
| 测试：D6 抑制 | T11 |
| 测试：对称（web-agent 经代理） | T18、T19 |
| 测试：改 module/DI 真启动验证 | T7、T13、T14、T17、T18、T20 |
| 交付顺序 1-7 + 可中断点 | T1-T7 / T8-T10 / **T11-T12（⭐点 A）** / **T13-T15（⭐点 B）** / T16-T17 / T18-T19 / T20 |
