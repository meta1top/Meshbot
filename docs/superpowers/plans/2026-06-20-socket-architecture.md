# Socket 架构梳理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面端到 server-agent 的实时通道收敛为两条 app 级常驻 WS（`ws/session` 流式 + `ws/events` 全局事件总线），统一全局事件为信封 `{type,payload,ts}`，并补齐已读跨端同步与定时任务全局推送。

**Architecture:** 保留 `ws/session`（agent 推理 token 流，按 session 订阅 room）。把现有 server-agent `ws/im` 浏览器侧网关升级为 `ws/events` 通用事件总线：所有下行（云端 relay 来的 IM 事件 + server-agent 本地事件）统一包成信封 `{type,payload,ts}`，经单一 `event` 事件按 `acct:<cloudUserId>` room 下发；前端一个 handler 按 `type` 分发到 atom。新增云端 `im.conversation_read`（已读广播，多端清未读）与本地 `schedule.fired`（定时任务触发）。

**Tech Stack:** NestJS + socket.io（gateway）、@nestjs/event-emitter（EventEmitter2 进程内总线）、socket.io-client（前端）、Jotai（前端状态）、Zod（schema）、Jest（server-agent/libs 单测，root 配置）。

## Global Constraints

- 浏览器↔server-agent 全局事件总线 namespace = `ws/events`（新增常量 `EVENTS_WS_NAMESPACE`）。**`IM_WS_NAMESPACE = "ws/im"` 不变**——它是 server-agent relay 连 server-main、以及 server-main 网关自身的 namespace，本计划不动。
- 总线 `type` 字符串 = 事件常量值；网关只把事件**包成信封**，不翻译名字。IM 域沿用 `im.*`（`IM_WS_EVENTS`）。
- 下行账号路由沿用现有 `acct:<cloudUserId>` room；无账号上下文降级全量广播（保不丢）。
- 未读：新消息由 `im.message` 客端本地 +1（自己发的/当前会话不计，已实现）；`im.conversation_read` 负责跨窗口/端清零。
- server-agent 本地事件本期仅 `schedule.fired`。
- 无 DB schema 变更、无 DDL。
- 中文 JSDoc；提交用中文 conventional commit；提交前过 `pnpm check` 与受影响包 `typecheck`。
- 流式 `ws/session` 通道本计划不改其事件/协议（仅 §Task 7 改随手问 dock 的挂载方式，使其隐藏不退订）。

---

## File Structure

**新增 / 修改的共享类型**
- `libs/types/src/events/global-event.ts`（新）：`GlobalEventEnvelopeSchema` + `GlobalEventEnvelope` 类型 + `EVENTS_WS_NAMESPACE = "ws/events"`。
- `libs/types/src/im/im.events.ts`（改）：`IM_WS_EVENTS` 增 `conversationRead: "im.conversation_read"`；增 `ImConversationReadEvent` 类型。
- `libs/types-agent/src/schedule.events.ts`（新）：`SCHEDULE_EVENTS = { fired: "schedule.fired" }` + `ScheduleFiredEvent` 类型/schema。
- `libs/types/src/index.ts`、`libs/types-agent/src/index.ts`（改）：导出新符号。

**server-main（云端）**
- `libs/main/src/services/conversation.service.ts`（改）：`markRead` 返回写入的 `Date`。
- `libs/main/src/services/conversation.service.spec.ts`（改）：markRead 测试断言返回值。
- `apps/server-main/src/ws/im.gateway.ts`（改）：`handleRead` 成功后广播 `im.conversation_read` 给该用户连接。
- `apps/server-main/src/ws/im.gateway.spec.ts`（新）：handleRead 广播单测。

**server-agent（本地）**
- `apps/server-agent/src/ws/im.gateway.ts` → 重命名 `apps/server-agent/src/ws/events.gateway.ts`；类 `ImGateway` → `EventsGateway`；namespace 改 `EVENTS_WS_NAMESPACE`；下行 `@OnEvent` 包信封 + 增 `im.conversation_read`、`schedule.fired`。
- `apps/server-agent/src/ws/im.gateway.spec.ts` → 重命名 `events.gateway.spec.ts`：断言信封 + 路由。
- `apps/server-agent/src/cloud/im-relay-client.service.ts`（改）：下行监听增 `IM_WS_EVENTS.conversationRead`。
- `apps/server-agent/src/services/schedule-executor.service.ts`（改）：注入 `EventEmitter2`，`fire()` 触发后 emit `schedule.fired`。
- `apps/server-agent/src/services/schedule-executor.service.spec.ts`（新或改）：fire 触发 emit 断言。
- `apps/server-agent/src/im.module.ts`（改）：`ImGateway` → `EventsGateway`。

**web-agent（前端）**
- `apps/web-agent/src/lib/im-socket.ts` → 重命名 `apps/web-agent/src/lib/events-socket.ts`：`getEventsSocket()` 连 `ws/events`；`disconnectEventsSocket()`。
- `apps/web-agent/src/hooks/use-im-realtime.ts` → 重命名 `apps/web-agent/src/hooks/use-global-events.ts`：`on("event")` → `dispatchGlobalEvent` 按 type 分发；导出纯函数 `dispatchGlobalEvent`。
- `apps/web-agent/src/hooks/use-global-events.spec.ts`（新）：`dispatchGlobalEvent` 路由单测。
- `apps/web-agent/src/atoms/schedule-activity.ts`（新）：`scheduleActivityAtom`（Set<sessionId>）+ add/clear write atom。
- `apps/web-agent/src/components/layouts/app-shell-layout.tsx`（改）：`useImRealtime` → `useGlobalEvents`；随手问 dock 由 `panelOpen && <aside>` 改为常驻挂载（CSS 隐藏）。
- `apps/web-agent/src/components/im/im-conversation-body.tsx`、`apps/web-agent/src/components/im/new-message-view.tsx`（改）：`getImSocket` → `getEventsSocket`。
- `apps/web-agent/src/components/sidebar/session-list-item.tsx`（改）：定时活动红点 + 打开清除。

---

### Task 1: 共享类型 — 信封 + 新事件常量

**Files:**
- Create: `libs/types/src/events/global-event.ts`
- Modify: `libs/types/src/im/im.events.ts`
- Create: `libs/types-agent/src/schedule.events.ts`
- Modify: `libs/types/src/index.ts`, `libs/types-agent/src/index.ts`

**Interfaces:**
- Produces:
  - `EVENTS_WS_NAMESPACE = "ws/events"`（`@meshbot/types`）
  - `GlobalEventEnvelope = { type: string; payload: unknown; ts: number }` + `GlobalEventEnvelopeSchema`（`@meshbot/types`）
  - `IM_WS_EVENTS.conversationRead = "im.conversation_read"`；`ImConversationReadEvent = { conversationId: string; lastReadAt: string }`（`@meshbot/types`）
  - `SCHEDULE_EVENTS = { fired: "schedule.fired" }`；`ScheduleFiredEvent = { sessionId: string; jobId: string; title: string }` + `ScheduleFiredEventSchema`（`@meshbot/types-agent`）

注：本任务是纯类型/常量声明，验证关口为 `typecheck`（其行为由 Task 3/4/5 的 gateway/dispatcher 单测覆盖）。

- [ ] **Step 1: 新建信封类型 + namespace 常量**

`libs/types/src/events/global-event.ts`:
```ts
import { z } from "zod";

/** 浏览器 ↔ server-agent 全局事件总线 namespace。注意：不同于 server-main/relay 的 ws/im。 */
export const EVENTS_WS_NAMESPACE = "ws/events";

/**
 * 全局事件总线信封：下行单一事件名 `event` 的统一载荷。
 * type = 事件常量值（如 im.message / im.conversation_read / schedule.fired）；
 * payload 由各 type 自行约束；ts 为毫秒时间戳。
 */
export const GlobalEventEnvelopeSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
  ts: z.number(),
});

export type GlobalEventEnvelope = z.infer<typeof GlobalEventEnvelopeSchema>;
```

- [ ] **Step 2: IM 事件常量增 conversationRead**

修改 `libs/types/src/im/im.events.ts`，在 `IM_WS_EVENTS` 下行段加一行、并加 payload 类型：
```ts
export const IM_WS_EVENTS = {
  // server → client（下行；server-agent EventEmitter2 上也用这套名）
  message: "im.message",
  presence: "im.presence",
  conversationCreated: "im.conversation_created",
  conversationRemoved: "im.conversation_removed",
  conversationRead: "im.conversation_read",
  // client → server（上行）
  send: "im.send",
  read: "im.read",
  ping: "im.ping",
} as const;
```
并在该文件「下行事件 payload」段后追加：
```ts
/** 某用户某会话已读（广播给该用户全部连接，用于多端清未读）。 */
export interface ImConversationReadEvent {
  conversationId: string;
  lastReadAt: string;
}
```

- [ ] **Step 3: 新建 schedule 事件类型（types-agent）**

`libs/types-agent/src/schedule.events.ts`:
```ts
import { z } from "zod";

/** server-agent 本地事件：定时任务触发。 */
export const SCHEDULE_EVENTS = {
  fired: "schedule.fired",
} as const;

export const ScheduleFiredEventSchema = z.object({
  sessionId: z.string(),
  jobId: z.string(),
  title: z.string(),
});

export type ScheduleFiredEvent = z.infer<typeof ScheduleFiredEventSchema>;
```

- [ ] **Step 4: 导出新符号**

`libs/types/src/index.ts` 用**具名 export 块**。在现有 `./im/im.events` 块内加一行 `type ImConversationReadEvent,`（与其它 `Im*` 类型并列），并新增一个块：
```ts
export {
  EVENTS_WS_NAMESPACE,
  type GlobalEventEnvelope,
  GlobalEventEnvelopeSchema,
} from "./events/global-event";
```
`libs/types-agent/src/index.ts` 用 `export *` 风格（已有 `export * from "./schedule"`，勿混淆——新文件名是 `schedule.events`），追加：
```ts
export * from "./schedule.events";
```

- [ ] **Step 5: typecheck**

Run: `pnpm --filter @meshbot/types --filter @meshbot/types-agent typecheck`
Expected: 两个包 typecheck 通过，无错误。

- [ ] **Step 6: Commit**

```bash
git add libs/types/src/events/global-event.ts libs/types/src/im/im.events.ts libs/types-agent/src/schedule.events.ts libs/types/src/index.ts libs/types-agent/src/index.ts
git commit -m "feat(types): 全局事件信封 + ws/events namespace + im.conversation_read/schedule.fired 常量"
```

---

### Task 2: server-main — markRead 返回时间戳 + 广播 im.conversation_read

**Files:**
- Modify: `libs/main/src/services/conversation.service.ts`（`markRead`）
- Modify: `libs/main/src/services/conversation.service.spec.ts`（markRead 两个测试）
- Modify: `apps/server-main/src/ws/im.gateway.ts`（`handleRead`）
- Create: `apps/server-main/src/ws/im.gateway.spec.ts`

**Interfaces:**
- Consumes: `IM_WS_EVENTS.conversationRead`、`ImConversationReadEvent`（Task 1）
- Produces: `ConversationService.markRead(conversationId, userId): Promise<Date>`（返回写入的 lastReadAt）

- [ ] **Step 1: 改 markRead 测试，断言返回写入的 Date**

修改 `libs/main/src/services/conversation.service.spec.ts` 的 markRead describe（现两测：「已有成员行 → save 更新」「无成员行 → create+save」），各自末尾加返回值断言：
```ts
// 「已有成员行」测试末尾追加：
const ret = await svc.markRead("conv-1", "user-1");
expect(ret).toBeInstanceOf(Date);
expect(ret).toBe(member.lastReadAt); // 返回的就是写入成员行的同一个 Date
```
```ts
// 「无成员行」测试：把 create 桩改为可回读写入对象，断言返回该 Date
const created: { lastReadAt?: Date } = {};
const create = jest.fn().mockImplementation((d: { lastReadAt: Date }) => {
  created.lastReadAt = d.lastReadAt;
  return d;
});
// ... memberRepo = makeMemberRepo({ findOne: ...null, create, save });
const ret = await svc.markRead("conv-1", "user-1");
expect(ret).toBeInstanceOf(Date);
expect(ret).toBe(created.lastReadAt);
```

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @meshbot/main test -- conversation.service`
Expected: FAIL —— markRead 当前返回 `void`，`ret` 为 undefined，断言不过。

- [ ] **Step 3: 改 markRead 返回 Date**

修改 `libs/main/src/services/conversation.service.ts` 的 `markRead`：
```ts
  async markRead(conversationId: string, userId: string): Promise<Date> {
    const now = new Date();
    const member = await this.memberRepo.findOne({
      where: { conversationId, userId },
    });
    if (member) {
      member.lastReadAt = now;
      await this.memberRepo.save(member);
      return now;
    }
    await this.memberRepo.save(
      this.memberRepo.create({ conversationId, userId, lastReadAt: now }),
    );
    return now;
  }
```

- [ ] **Step 4: 跑测试看通过**

Run: `pnpm --filter @meshbot/main test -- conversation.service`
Expected: PASS（全部 conversation.service 测试通过）。

- [ ] **Step 5: 写 handleRead 广播单测（先失败）**

`apps/server-main/src/ws/im.gateway.spec.ts`（新）。构造 gateway，桩 conversation（getVisibleOrThrow + markRead）、server（in().fetchSockets()）：
```ts
import { IM_WS_EVENTS } from "@meshbot/types";
import { ImGateway } from "./im.gateway";

function makeGateway(overrides: {
  markReadReturn?: Date;
  sockets?: Array<{ data: { user?: { userId?: string } }; emit: jest.Mock }>;
}) {
  const conversation = {
    getVisibleOrThrow: jest.fn().mockResolvedValue({ id: "c1" }),
    markRead: jest
      .fn()
      .mockResolvedValue(overrides.markReadReturn ?? new Date("2026-06-20T00:00:00Z")),
  };
  const gw = new ImGateway(
    {} as never, // jwt
    conversation as never,
    {} as never, // message
    {} as never, // presence
    {} as never, // userService
  );
  const fetchSockets = jest
    .fn()
    .mockResolvedValue(overrides.sockets ?? []);
  (gw as unknown as { server: unknown }).server = {
    in: jest.fn().mockReturnValue({ fetchSockets }),
  };
  return { gw, conversation };
}

describe("ImGateway.handleRead 广播 im.conversation_read", () => {
  it("markRead 后只向该用户的连接广播 conversation_read", async () => {
    const lastReadAt = new Date("2026-06-20T01:02:03Z");
    const mine = { data: { user: { userId: "u1" } }, emit: jest.fn() };
    const other = { data: { user: { userId: "u2" } }, emit: jest.fn() };
    const { gw } = makeGateway({ markReadReturn: lastReadAt, sockets: [mine, other] });
    const client = { data: { orgId: "org1", user: { userId: "u1" } } };

    await gw.handleRead({ conversationId: "c1" } as never, client as never);

    expect(mine.emit).toHaveBeenCalledWith(IM_WS_EVENTS.conversationRead, {
      conversationId: "c1",
      lastReadAt: lastReadAt.toISOString(),
    });
    expect(other.emit).not.toHaveBeenCalled();
  });

  it("无 orgId → 不广播", async () => {
    const sock = { data: { user: { userId: "u1" } }, emit: jest.fn() };
    const { gw } = makeGateway({ sockets: [sock] });
    await gw.handleRead({ conversationId: "c1" } as never, { data: {} } as never);
    expect(sock.emit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: 跑测试看失败**

Run: `pnpm test -- im.gateway`（server-main 无独立 `test` 脚本，走 root jest；已确认 server-main 有 `*.spec.ts` 单测如 email-sender/redis-io.adapter 经 root jest 运行）
Expected: FAIL —— 当前 handleRead 不广播，`mine.emit` 未被调用。
注：此名也会匹配 server-agent 当前的 `im.gateway.spec`（Task 3 才改名为 events.gateway），两者都应通过，不影响判断本任务的新失败用例。

- [ ] **Step 7: handleRead 广播 conversation_read**

修改 `apps/server-main/src/ws/im.gateway.ts` 的 `handleRead`（现：getVisibleOrThrow → markRead）：
```ts
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(IM_WS_EVENTS.read)
  async handleRead(
    @MessageBody() body: ImReadInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const orgId: string | undefined = client.data?.orgId;
    if (!orgId) return;

    const userId: string = client.data.user.userId;

    await this.conversation.getVisibleOrThrow(
      body.conversationId,
      userId,
      orgId,
    );

    const lastReadAt = await this.conversation.markRead(
      body.conversationId,
      userId,
    );

    // 广播给「该用户」的全部在线连接（多窗口/多端清未读）；按 org 房间取连接后按 userId 过滤
    const sockets = await this.server.in(`org:${orgId}`).fetchSockets();
    for (const s of sockets) {
      if (s.data.user?.userId === userId) {
        s.emit(IM_WS_EVENTS.conversationRead, {
          conversationId: body.conversationId,
          lastReadAt: lastReadAt.toISOString(),
        } satisfies ImConversationReadEvent);
      }
    }
  }
```
并确保该文件已 import `ImConversationReadEvent`（在顶部 `@meshbot/types` import 块加入）。

- [ ] **Step 8: 跑测试看通过 + typecheck**

Run: `pnpm test -- im.gateway`
Expected: PASS。
Run: `pnpm --filter @meshbot/main --filter @meshbot/server-main typecheck`
Expected: 通过。

- [ ] **Step 9: Commit**

```bash
git add libs/main/src/services/conversation.service.ts libs/main/src/services/conversation.service.spec.ts apps/server-main/src/ws/im.gateway.ts apps/server-main/src/ws/im.gateway.spec.ts
git commit -m "feat(server-main): markRead 返回时间戳 + handleRead 广播 im.conversation_read（多端已读同步）"
```

---

### Task 3: server-agent — ws/events 网关（信封封装 + conversation_read 转发）

**Files:**
- Rename: `apps/server-agent/src/ws/im.gateway.ts` → `apps/server-agent/src/ws/events.gateway.ts`（类 `ImGateway` → `EventsGateway`）
- Rename: `apps/server-agent/src/ws/im.gateway.spec.ts` → `apps/server-agent/src/ws/events.gateway.spec.ts`
- Modify: `apps/server-agent/src/cloud/im-relay-client.service.ts`（下行监听）
- Modify: `apps/server-agent/src/im.module.ts`（provider 名）

**Interfaces:**
- Consumes: `EVENTS_WS_NAMESPACE`、`GlobalEventEnvelope`、`IM_WS_EVENTS.conversationRead`（Task 1）
- Produces: `EventsGateway`（浏览器侧 `ws/events`，下行单一 `event` 信封；上行仍 `im.send`/`im.read`/`im.ping`）

- [ ] **Step 1: git mv 两个文件 + 改类名/namespace（先不动测试断言）**

```bash
git mv apps/server-agent/src/ws/im.gateway.ts apps/server-agent/src/ws/events.gateway.ts
git mv apps/server-agent/src/ws/im.gateway.spec.ts apps/server-agent/src/ws/events.gateway.spec.ts
```
在 `events.gateway.ts`：类名 `ImGateway` → `EventsGateway`；`@WebSocketGateway({ namespace: IM_WS_NAMESPACE, cors: true })` → `@WebSocketGateway({ namespace: EVENTS_WS_NAMESPACE, cors: true })`；顶部 import 增 `EVENTS_WS_NAMESPACE`、`GlobalEventEnvelope`（来自 `@meshbot/types`）。`im.module.ts` 把 `ImGateway` import/providers 改为 `EventsGateway`（import 路径改 `./ws/events.gateway`）。

- [ ] **Step 2: 改 events.gateway.spec.ts 断言信封（先失败）**

把现有 `events.gateway.spec.ts`（原 im.gateway 测试，断言 `roomEmit`/`broadcastEmit` 收到具名事件）改为断言**单一 `event` + 信封**。完整替换为：
```ts
import { AccountContextService } from "@meshbot/agent";
import { IM_WS_EVENTS } from "@meshbot/types";

import { EventsGateway } from "./events.gateway";

function makeGateway(account: AccountContextService) {
  const gw = new EventsGateway({} as never, {} as never, account);
  const broadcastEmit = jest.fn();
  const roomEmit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit: roomEmit });
  (gw as unknown as { server: unknown }).server = { emit: broadcastEmit, to };
  return { gw, broadcastEmit, roomEmit, to };
}

describe("EventsGateway 下行信封 + 账号路由", () => {
  const msg = { id: "m1", conversationId: "c1", senderId: "u2", content: "1" };

  it("有账号上下文 → 发 acct 房间的单一 event，载荷为信封", () => {
    const account = new AccountContextService();
    const { gw, broadcastEmit, roomEmit, to } = makeGateway(account);

    account.run("U1", () => gw.onMessage(msg as never));

    expect(to).toHaveBeenCalledWith("acct:U1");
    expect(roomEmit).toHaveBeenCalledTimes(1);
    const [eventName, env] = roomEmit.mock.calls[0];
    expect(eventName).toBe("event");
    expect(env.type).toBe(IM_WS_EVENTS.message);
    expect(env.payload).toEqual(msg);
    expect(typeof env.ts).toBe("number");
    expect(broadcastEmit).not.toHaveBeenCalled();
  });

  it("im.conversation_read 也走信封", () => {
    const account = new AccountContextService();
    const { gw, roomEmit } = makeGateway(account);
    const payload = { conversationId: "c1", lastReadAt: "2026-06-20T00:00:00.000Z" };
    account.run("U1", () => gw.onConversationRead(payload as never));
    const [eventName, env] = roomEmit.mock.calls[0];
    expect(eventName).toBe("event");
    expect(env.type).toBe(IM_WS_EVENTS.conversationRead);
    expect(env.payload).toEqual(payload);
  });

  it("无账号上下文 → 降级全量广播单一 event", () => {
    const account = new AccountContextService();
    const { gw, broadcastEmit, to } = makeGateway(account);
    gw.onMessage(msg as never);
    expect(to).not.toHaveBeenCalled();
    const [eventName, env] = broadcastEmit.mock.calls[0];
    expect(eventName).toBe("event");
    expect(env.type).toBe(IM_WS_EVENTS.message);
  });

  it("handleConnection：已鉴权 socket 加入 acct:<sub>", () => {
    const account = new AccountContextService();
    const { gw } = makeGateway(account);
    const join = jest.fn();
    gw.handleConnection({ data: { user: { sub: "U1" } }, join, once: jest.fn() } as never);
    expect(join).toHaveBeenCalledWith("acct:U1");
  });
});
```

- [ ] **Step 3: 跑测试看失败**

Run: `pnpm test -- events.gateway`
Expected: FAIL —— 当前 `@OnEvent` 直接 `emitToAccount(具名事件, payload)`，没有 `event` 信封；也没有 `onConversationRead`。

- [ ] **Step 4: 网关下行改为统一信封 + 增 conversation_read**

在 `events.gateway.ts`：把 `emitToAccount(event, payload)` 改为「包信封后发单一 `event`」，4 个 `@OnEvent` 改为调它并增 `onConversationRead`。`emitToAccount` 改名 `emitEnvelope` 并改实现：
```ts
  @OnEvent(IM_WS_EVENTS.message)
  onMessage(payload: ImMessage): void {
    this.emitEnvelope(IM_WS_EVENTS.message, payload);
  }

  @OnEvent(IM_WS_EVENTS.presence)
  onPresence(payload: PresenceState): void {
    this.emitEnvelope(IM_WS_EVENTS.presence, payload);
  }

  @OnEvent(IM_WS_EVENTS.conversationCreated)
  onConversationCreated(payload: ConversationSummary): void {
    this.emitEnvelope(IM_WS_EVENTS.conversationCreated, payload);
  }

  @OnEvent(IM_WS_EVENTS.conversationRemoved)
  onConversationRemoved(payload: { conversationId: string }): void {
    this.emitEnvelope(IM_WS_EVENTS.conversationRemoved, payload);
  }

  @OnEvent(IM_WS_EVENTS.conversationRead)
  onConversationRead(payload: ImConversationReadEvent): void {
    this.emitEnvelope(IM_WS_EVENTS.conversationRead, payload);
  }

  /**
   * 下行投递：把任意事件包成全局信封 `{type,payload,ts}`，以单一 `event` 名只发给
   * 当前下行事件所属账号的 acct 房间（relay 经 account.run 同步触发，故能取到账号）。
   * 无账号上下文（理论不应发生）→ 降级全量广播，保证不丢。
   */
  private emitEnvelope(type: string, payload: unknown): void {
    const env: GlobalEventEnvelope = { type, payload, ts: Date.now() };
    const cloudUserId = this.account.get();
    if (!cloudUserId) {
      this.server.emit("event", env);
      return;
    }
    this.server.to(`acct:${cloudUserId}`).emit("event", env);
  }
```
顶部 import 增 `ImConversationReadEvent`、`GlobalEventEnvelope`（`@meshbot/types`）。类 JSDoc 同步更新「下行：单一 event 信封」。

- [ ] **Step 5: relay 下行监听增 conversation_read**

修改 `apps/server-agent/src/cloud/im-relay-client.service.ts` 的下行事件循环（现 4 个）增一项：
```ts
      for (const event of [
        IM_WS_EVENTS.message,
        IM_WS_EVENTS.presence,
        IM_WS_EVENTS.conversationCreated,
        IM_WS_EVENTS.conversationRemoved,
        IM_WS_EVENTS.conversationRead,
      ] as const) {
```

- [ ] **Step 6: 跑测试看通过 + typecheck**

Run: `pnpm test -- events.gateway`
Expected: PASS。
Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 通过（im.module 引用 EventsGateway 无误）。

- [ ] **Step 7: Commit**

```bash
git add apps/server-agent/src/ws/events.gateway.ts apps/server-agent/src/ws/events.gateway.spec.ts apps/server-agent/src/cloud/im-relay-client.service.ts apps/server-agent/src/im.module.ts
git commit -m "feat(server-agent): ws/im 升级为 ws/events 事件总线（统一信封）+ 转发 im.conversation_read"
```

---

### Task 4: server-agent — 定时任务触发 schedule.fired

**Files:**
- Modify: `apps/server-agent/src/services/schedule-executor.service.ts`（注入 EventEmitter2 + fire emit）
- Create: `apps/server-agent/src/services/schedule-executor.service.spec.ts`
- Modify: `apps/server-agent/src/ws/events.gateway.ts`（增 `@OnEvent(schedule.fired)`）
- Modify: `apps/server-agent/src/ws/events.gateway.spec.ts`（断言）

**Interfaces:**
- Consumes: `SCHEDULE_EVENTS`、`ScheduleFiredEvent`（Task 1）、`EventsGateway.emitEnvelope`（Task 3）
- Produces: `ScheduleExecutor.fire` 在投递消息后 emit `schedule.fired`

- [ ] **Step 1: 写 fire emit 单测（先失败）**

`apps/server-agent/src/services/schedule-executor.service.spec.ts`（新）。只测 fire 的「触发后 emit schedule.fired」，桩掉依赖：
```ts
import { SCHEDULE_EVENTS } from "@meshbot/types-agent";
import { AccountContextService } from "@meshbot/agent";
import { ScheduleExecutor } from "./schedule-executor.service";

function build(emit: jest.Mock) {
  const job = {
    id: "job1",
    sessionId: "s1",
    cloudUserId: "U1",
    prompt: "do it",
    kind: "cron" as const,
    cronExpr: "* * * * *",
    timezone: null,
    enabled: true,
  };
  const schedule = {
    findByIdUnscoped: jest.fn().mockResolvedValue(job),
    markFired: jest.fn().mockResolvedValue(undefined),
    setEnabled: jest.fn(),
  };
  const sessions = {
    findOrNull: jest.fn().mockResolvedValue({ id: "s1", title: "我的任务" }),
    appendMessage: jest.fn().mockResolvedValue(undefined),
  };
  const runner = { kick: jest.fn() };
  const runtime = { has: jest.fn().mockReturnValue(true) };
  const account = new AccountContextService();
  const emitter = { emit } as never;
  const exec = new ScheduleExecutor(
    schedule as never,
    {} as never, // SchedulerRegistry
    sessions as never,
    runner as never,
    account,
    runtime as never,
    emitter,
  );
  return { exec, runner, sessions };
}

describe("ScheduleExecutor.fire emit schedule.fired", () => {
  it("投递消息 + kick 后 emit schedule.fired（带 session title）", async () => {
    const emit = jest.fn();
    const { exec, runner, sessions } = build(emit);
    await exec.fire("job1");
    expect(sessions.appendMessage).toHaveBeenCalled();
    expect(runner.kick).toHaveBeenCalledWith("s1");
    expect(emit).toHaveBeenCalledWith(SCHEDULE_EVENTS.fired, {
      sessionId: "s1",
      jobId: "job1",
      title: "我的任务",
    });
  });
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm test -- schedule-executor`
Expected: FAIL —— 构造函数还没有第 7 个参数 `emitter`，且 fire 未 emit。

- [ ] **Step 3: 注入 EventEmitter2 + fire emit**

修改 `apps/server-agent/src/services/schedule-executor.service.ts`：
顶部 import：
```ts
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import { SCHEDULE_EVENTS, type ScheduleFiredEvent } from "@meshbot/types-agent";
```
（`OnEvent` 已 import，则只补 `EventEmitter2`。）
构造函数末尾加参数：
```ts
    private readonly runtime: AccountRuntimeRegistry,
    private readonly emitter: EventEmitter2,
  ) {}
```
`fire()` 内 `account.run` 回调里、`this.runner.kick(job.sessionId);` 之后插入：
```ts
      this.runner.kick(job.sessionId);
      this.emitter.emit(SCHEDULE_EVENTS.fired, {
        sessionId: job.sessionId,
        jobId: job.id,
        title: session.title,
      } satisfies ScheduleFiredEvent);
```
（`session` 即上文 `findOrNull` 的返回；`title` 字段存在于 session 摘要。若 `findOrNull` 返回类型无 `title`，用 `session.title ?? ""`。）

- [ ] **Step 4: 网关增 schedule.fired @OnEvent + 测试**

在 `events.gateway.ts` 增：
```ts
  @OnEvent(SCHEDULE_EVENTS.fired)
  onScheduleFired(payload: ScheduleFiredEvent): void {
    this.emitEnvelope(SCHEDULE_EVENTS.fired, payload);
  }
```
顶部 import：`import { SCHEDULE_EVENTS, type ScheduleFiredEvent } from "@meshbot/types-agent";`。
在 `events.gateway.spec.ts` 增一例：
```ts
  it("schedule.fired 本地事件包信封下发", () => {
    const account = new AccountContextService();
    const { gw, roomEmit } = makeGateway(account);
    const payload = { sessionId: "s1", jobId: "j1", title: "t" };
    account.run("U1", () => gw.onScheduleFired(payload as never));
    const [eventName, env] = roomEmit.mock.calls[0];
    expect(eventName).toBe("event");
    expect(env.type).toBe("schedule.fired");
    expect(env.payload).toEqual(payload);
  });
```

- [ ] **Step 5: 跑测试看通过 + typecheck**

Run: `pnpm test -- "schedule-executor|events.gateway"`
Expected: PASS（两套都过）。
Run: `pnpm --filter @meshbot/server-agent typecheck`
Expected: 通过。

- [ ] **Step 6: Commit**

```bash
git add apps/server-agent/src/services/schedule-executor.service.ts apps/server-agent/src/services/schedule-executor.service.spec.ts apps/server-agent/src/ws/events.gateway.ts apps/server-agent/src/ws/events.gateway.spec.ts
git commit -m "feat(server-agent): 定时任务触发 emit schedule.fired 入全局事件总线"
```

---

### Task 5: web-agent — getEventsSocket + useGlobalEvents 分发器

**Files:**
- Rename: `apps/web-agent/src/lib/im-socket.ts` → `apps/web-agent/src/lib/events-socket.ts`
- Rename: `apps/web-agent/src/hooks/use-im-realtime.ts` → `apps/web-agent/src/hooks/use-global-events.ts`
- Create: `apps/web-agent/src/hooks/use-global-events.spec.ts`
- Create: `apps/web-agent/src/atoms/schedule-activity.ts`
- Modify: `apps/web-agent/src/components/layouts/app-shell-layout.tsx`（hook 改名）
- Modify: `apps/web-agent/src/components/im/im-conversation-body.tsx`、`apps/web-agent/src/components/im/new-message-view.tsx`（socket 改名）

**Interfaces:**
- Consumes: `EVENTS_WS_NAMESPACE`、`GlobalEventEnvelope`、`IM_WS_EVENTS`（Task 1）；`SCHEDULE_EVENTS`（Task 1）；`markConversationReadAtom`（已存在）
- Produces: `getEventsSocket()`、`disconnectEventsSocket()`、`useGlobalEvents()`、纯函数 `dispatchGlobalEvent(env, handlers)`、`scheduleActivityAtom` + `addScheduleActivityAtom`/`clearScheduleActivityAtom`

- [ ] **Step 1: 重命名 socket 工厂 → ws/events**

```bash
git mv apps/web-agent/src/lib/im-socket.ts apps/web-agent/src/lib/events-socket.ts
```
在 `events-socket.ts`：import `EVENTS_WS_NAMESPACE`（替换 `IM_WS_NAMESPACE`）；`getImSocket` → `getEventsSocket`；`disconnectImSocket` → `disconnectEventsSocket`；连接 URL 用 `${base}/${EVENTS_WS_NAMESPACE}`。

- [ ] **Step 2: 新建定时活动 atom**

`apps/web-agent/src/atoms/schedule-activity.ts`:
```ts
"use client";

import { atom } from "jotai";

/** 有「定时任务刚触发」未查看的助手会话 id 集合（侧栏红点用）。 */
export const scheduleActivityAtom = atom<Set<string>>(new Set<string>());

/** 标记某会话有定时活动。 */
export const addScheduleActivityAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const next = new Set(get(scheduleActivityAtom));
    next.add(sessionId);
    set(scheduleActivityAtom, next);
  },
);

/** 清除某会话的定时活动标记（打开该会话时调用）。 */
export const clearScheduleActivityAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const cur = get(scheduleActivityAtom);
    if (!cur.has(sessionId)) return;
    const next = new Set(cur);
    next.delete(sessionId);
    set(scheduleActivityAtom, next);
  },
);
```

- [ ] **Step 3: 写分发器纯函数单测（先失败）**

`apps/web-agent/src/hooks/use-global-events.spec.ts`:
```ts
import { IM_WS_EVENTS } from "@meshbot/types";
import { SCHEDULE_EVENTS } from "@meshbot/types-agent";
import { dispatchGlobalEvent } from "./use-global-events";

function makeHandlers() {
  return {
    onMessage: jest.fn(),
    onPresence: jest.fn(),
    onConversationCreated: jest.fn(),
    onConversationRemoved: jest.fn(),
    onConversationRead: jest.fn(),
    onScheduleFired: jest.fn(),
  };
}

describe("dispatchGlobalEvent", () => {
  it.each([
    [IM_WS_EVENTS.message, "onMessage"],
    [IM_WS_EVENTS.presence, "onPresence"],
    [IM_WS_EVENTS.conversationCreated, "onConversationCreated"],
    [IM_WS_EVENTS.conversationRemoved, "onConversationRemoved"],
    [IM_WS_EVENTS.conversationRead, "onConversationRead"],
    [SCHEDULE_EVENTS.fired, "onScheduleFired"],
  ])("%s → %s", (type, handlerKey) => {
    const h = makeHandlers();
    const payload = { x: 1 };
    dispatchGlobalEvent({ type, payload, ts: 1 }, h);
    expect(h[handlerKey as keyof typeof h]).toHaveBeenCalledWith(payload);
  });

  it("未知 type → 不抛错、不调用任何 handler", () => {
    const h = makeHandlers();
    dispatchGlobalEvent({ type: "x.unknown", payload: {}, ts: 1 }, h);
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: 跑测试看失败**

Run: `pnpm test -- use-global-events`
Expected: FAIL —— `dispatchGlobalEvent` 未定义（文件还叫 use-im-realtime）。

- [ ] **Step 5: 重命名 hook + 写分发器**

```bash
git mv apps/web-agent/src/hooks/use-im-realtime.ts apps/web-agent/src/hooks/use-global-events.ts
```
把 `use-global-events.ts` 整体改写为「订阅单一 `event` + 按 type 分发」，并导出纯函数：
```ts
"use client";

import type {
  ConversationSummary,
  GlobalEventEnvelope,
  ImConversationReadEvent,
  ImMessage,
  PresenceState,
} from "@meshbot/types";
import { IM_WS_EVENTS } from "@meshbot/types";
import { SCHEDULE_EVENTS, type ScheduleFiredEvent } from "@meshbot/types-agent";
import { useSetAtom } from "jotai";
import { useEffect } from "react";
import {
  applyIncomingMessageAtom,
  markConversationReadAtom,
  removeConversationAtom,
  setPresenceAtom,
  upsertConversationAtom,
} from "@/atoms/im";
import { addScheduleActivityAtom } from "@/atoms/schedule-activity";
import { getEventsSocket } from "@/lib/events-socket";

/** 全局事件分发表：按信封 type 调对应 handler。纯函数，便于单测。 */
export interface GlobalEventHandlers {
  onMessage: (p: ImMessage) => void;
  onPresence: (p: PresenceState) => void;
  onConversationCreated: (p: ConversationSummary) => void;
  onConversationRemoved: (p: { conversationId: string }) => void;
  onConversationRead: (p: ImConversationReadEvent) => void;
  onScheduleFired: (p: ScheduleFiredEvent) => void;
}

export function dispatchGlobalEvent(
  env: GlobalEventEnvelope,
  h: GlobalEventHandlers,
): void {
  switch (env.type) {
    case IM_WS_EVENTS.message:
      h.onMessage(env.payload as ImMessage);
      break;
    case IM_WS_EVENTS.presence:
      h.onPresence(env.payload as PresenceState);
      break;
    case IM_WS_EVENTS.conversationCreated:
      h.onConversationCreated(env.payload as ConversationSummary);
      break;
    case IM_WS_EVENTS.conversationRemoved:
      h.onConversationRemoved(env.payload as { conversationId: string });
      break;
    case IM_WS_EVENTS.conversationRead:
      h.onConversationRead(env.payload as ImConversationReadEvent);
      break;
    case SCHEDULE_EVENTS.fired:
      h.onScheduleFired(env.payload as ScheduleFiredEvent);
      break;
    default:
      break;
  }
}

/**
 * Shell 级全局事件总线订阅（常驻，挂在 AppShellLayout）。单一 `event` 信封 → 按 type
 * 分发到 atom：IM 消息/在线/会话增删/已读、定时任务触发。任何页面都实时。
 */
export function useGlobalEvents(): void {
  const applyIncomingMessage = useSetAtom(applyIncomingMessageAtom);
  const setPresence = useSetAtom(setPresenceAtom);
  const upsertConversation = useSetAtom(upsertConversationAtom);
  const removeConversation = useSetAtom(removeConversationAtom);
  const markConversationRead = useSetAtom(markConversationReadAtom);
  const addScheduleActivity = useSetAtom(addScheduleActivityAtom);

  useEffect(() => {
    const socket = getEventsSocket();
    const handlers: GlobalEventHandlers = {
      onMessage: (p) => applyIncomingMessage(p),
      onPresence: (p) => setPresence(p),
      onConversationCreated: (p) => upsertConversation(p),
      onConversationRemoved: (p) => removeConversation(p.conversationId),
      onConversationRead: (p) => markConversationRead(p.conversationId),
      onScheduleFired: (p) => addScheduleActivity(p.sessionId),
    };
    const onEvent = (env: GlobalEventEnvelope) =>
      dispatchGlobalEvent(env, handlers);
    socket.on("event", onEvent);
    return () => {
      socket.off("event", onEvent);
    };
  }, [
    applyIncomingMessage,
    setPresence,
    upsertConversation,
    removeConversation,
    markConversationRead,
    addScheduleActivity,
  ]);
}
```

- [ ] **Step 6: 跑测试看通过**

Run: `pnpm test -- use-global-events`
Expected: PASS（6 路由 + 未知 type 共 7 例）。

- [ ] **Step 7: 改调用点（hook 名 + socket 名）**

- `apps/web-agent/src/components/layouts/app-shell-layout.tsx`：`import { useImRealtime } from "@/hooks/use-im-realtime"` → `import { useGlobalEvents } from "@/hooks/use-global-events"`；调用处 `useImRealtime()` → `useGlobalEvents()`。
- `apps/web-agent/src/components/im/im-conversation-body.tsx`：`import { getImSocket } from "@/lib/im-socket"` → `import { getEventsSocket } from "@/lib/events-socket"`；两处 `getImSocket()` → `getEventsSocket()`（read emit、send emit）。
- `apps/web-agent/src/components/im/new-message-view.tsx`：同上替换 import 与两处 `getImSocket()` → `getEventsSocket()`。

- [ ] **Step 8: typecheck + lint**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 通过（无残留 `getImSocket`/`useImRealtime`/`im-socket`/`use-im-realtime` 引用）。
Run: `pnpm exec biome check apps/web-agent/src/lib/events-socket.ts apps/web-agent/src/hooks/use-global-events.ts apps/web-agent/src/atoms/schedule-activity.ts`
Expected: 无错误。

- [ ] **Step 9: Commit**

```bash
git add apps/web-agent/src/lib/events-socket.ts apps/web-agent/src/hooks/use-global-events.ts apps/web-agent/src/hooks/use-global-events.spec.ts apps/web-agent/src/atoms/schedule-activity.ts apps/web-agent/src/components/layouts/app-shell-layout.tsx apps/web-agent/src/components/im/im-conversation-body.tsx apps/web-agent/src/components/im/new-message-view.tsx
git commit -m "feat(web-agent): getEventsSocket + useGlobalEvents 信封分发（ws/events），含 im.conversation_read/schedule.fired"
```

---

### Task 6: web-agent — 定时活动红点（schedule.fired 的 UI 落地）

**Files:**
- Modify: `apps/web-agent/src/components/sidebar/session-list-item.tsx`（红点 + 打开清除）

**Interfaces:**
- Consumes: `scheduleActivityAtom`、`clearScheduleActivityAtom`（Task 5）

- [ ] **Step 1: 列表项读活动集合 + 点击清除 + 红点**

修改 `apps/web-agent/src/components/sidebar/session-list-item.tsx`：
顶部加：
```ts
import { useAtomValue, useSetAtom } from "jotai";
import {
  clearScheduleActivityAtom,
  scheduleActivityAtom,
} from "@/atoms/schedule-activity";
```
组件内：
```ts
  const scheduleActivity = useAtomValue(scheduleActivityAtom);
  const clearScheduleActivity = useSetAtom(clearScheduleActivityAtom);
  const hasActivity = scheduleActivity.has(session.id);
```
打开会话的按钮 `onClick` 里，`router.push(...)` 之前加 `clearScheduleActivity(session.id);`。
在标题 button 之后、三点菜单之前，加红点（仅 `hasActivity && !active` 时显示，active 态已在看不需要）：
```tsx
        {hasActivity && !active && (
          <span className="mr-1 h-1.5 w-1.5 shrink-0 rounded-full bg-(--shell-accent)" aria-hidden />
        )}
```

- [ ] **Step 2: typecheck + lint**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 通过。
Run: `pnpm exec biome check apps/web-agent/src/components/sidebar/session-list-item.tsx`
Expected: 无错误。

- [ ] **Step 3: 目视验证（无单测；交互+样式）**

说明：红点为视觉/交互行为，单测价值低；本步为人工验证项——触发一个定时任务到未打开的助手会话 → 侧栏该会话出现红点 → 点击进入红点消失。实现者把此说明写入任务报告，最终整分支 review 时由人确认。

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/src/components/sidebar/session-list-item.tsx
git commit -m "feat(web-agent): 助手会话定时任务触发红点（schedule.fired）+ 打开清除"
```

---

### Task 7: web-agent — 随手问 dock 后台常驻（隐藏不退订）

**Files:**
- Modify: `apps/web-agent/src/components/layouts/app-shell-layout.tsx`（dock 挂载方式）

**Interfaces:**
- Consumes: 既有 `assistantPanelOpenAtom`、`assistantPanelWidthAtom`、`AssistantDock`、`startPanelResize`

- [ ] **Step 1: dock 由「条件渲染」改为「常驻 + CSS 隐藏」**

修改 `apps/web-agent/src/components/layouts/app-shell-layout.tsx` 当前的随手问片段：
```tsx
          {panelOpen && (
            <>
              {/* 拖拽手柄 ... */}
              <div aria-hidden onMouseDown={startPanelResize} className="..." >
                <div className="..." />
              </div>
              <aside style={{ width: panelWidth }} className="relative ml-1.5 hidden ... xl:flex">
                <AssistantDock />
              </aside>
            </>
          )}
```
改为：手柄仍随 `panelOpen` 显隐，但 **`<aside>`（含 `<AssistantDock/>`）始终挂载**，用 class 切换显隐——`panelOpen` 时 `xl:flex` 显示，否则 `hidden`（彻底不占布局也不显示），关键是不卸载：
```tsx
          {panelOpen && (
            <div
              aria-hidden
              onMouseDown={startPanelResize}
              className="group hidden w-1.5 shrink-0 cursor-col-resize xl:flex"
            >
              <div className="mx-auto h-full w-0.5 rounded-full transition-colors group-hover:bg-(--shell-accent)/60" />
            </div>
          )}
          {/* 随手问 dock 常驻挂载：关闭时 CSS 隐藏而非卸载，使后台流不退订、重开即时 */}
          <aside
            style={{ width: panelWidth }}
            className={cn(
              "ml-1.5 shrink-0 overflow-hidden rounded-(--shell-radius) bg-(--shell-content)",
              panelOpen ? "hidden xl:flex" : "hidden",
            )}
          >
            <AssistantDock />
          </aside>
```
注：`AssistantDock` 内 `useSessionStream(quickSessionId, …)` 在 `quickSessionId` 为 null 时不订阅（惰性），故常驻挂载不会在未开过随手问时就建连/建会话；首条消息后建 quick 会话并订阅，此后隐藏不退订。

- [ ] **Step 2: typecheck + lint**

Run: `pnpm --filter @meshbot/web-agent typecheck`
Expected: 通过。
Run: `pnpm exec biome check apps/web-agent/src/components/layouts/app-shell-layout.tsx`
Expected: 无错误。

- [ ] **Step 3: 目视验证（无单测；React 挂载行为）**

说明：在随手问发起一个较慢的提问 → 关闭面板（CSS 隐藏，dock 不卸载）→ 重开面板，应见流式仍在继续/已完成且内容完整（非重新拉取）。实现者写入任务报告，最终人工确认。

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/src/components/layouts/app-shell-layout.tsx
git commit -m "feat(web-agent): 随手问 dock 后台常驻（隐藏用 CSS 不卸载，流式不退订）"
```

---

## 收尾（全部任务后）

- [ ] 跑全量静态围栏与测试：`pnpm check` + `pnpm test` + `pnpm typecheck`。
- [ ] 重启验证：本计划改了 server-agent（`pnpm dev:server-agent`）与 server-main（`pnpm dev:server-main`），均需重启；web-agent 热更。
- [ ] 人工验证矩阵：①双账号一条消息收件方未读 +1（不重复）②A 窗口读 → B 窗口该会话未读清零（`im.conversation_read`）③定时任务触发未打开的助手会话 → 侧栏红点，打开清除 ④随手问关面板再开，流式不断 ⑤presence/新会话/新频道仍实时。

---

## Self-Review（计划自查）

- **Spec coverage**：§1 流式生命周期→Task 7（dock 常驻）+ 助手页 active-view 现状不变（无需改，spec 已声明保持）；§2 信封→Task 1/3，事件目录 im.*→Task 3、im.conversation_read→Task 2/3/5、schedule.fired→Task 4/5/6，acct 路由→Task 3（沿用现有）；server-main 改动→Task 2；server-agent 改动→Task 3/4；前端→Task 5/6/7；§6 命名迁移 ws/im→ws/events→Task 3/5（且明确不动 relay/server-main 的 IM_WS_NAMESPACE）。未读「客端 +1」沿用现状（已实现），「read 广播清零」→Task 2/3/5。覆盖完整。
- **Placeholder scan**：各 code step 均含真实代码 / 真实命令 / 期望输出；无 TBD/TODO。Task 1 Step 4 注明「先 cat index 确认 re-export 风格」属操作指引非占位。
- **Type consistency**：`markRead → Promise<Date>`（Task 2 定义，Task 2 内自用）；`EventsGateway.emitEnvelope(type, payload)`（Task 3 定义，Task 4 复用）；`GlobalEventEnvelope{type,payload,ts}`（Task 1，Task 3 产、Task 5 消费）；`dispatchGlobalEvent(env, handlers)` 与 `GlobalEventHandlers`（Task 5 一处定义自用）；`scheduleActivityAtom`/`addScheduleActivityAtom`/`clearScheduleActivityAtom`（Task 5 定义，Task 5/6 消费）；`SCHEDULE_EVENTS.fired`/`ScheduleFiredEvent{sessionId,jobId,title}`（Task 1，Task 4 产、Task 5 消费、Task 6 用 sessionId）。一致。
- **风险点**：①server-main 单测走 **root jest**（已确认有 email-sender/redis-io.adapter `*.spec.ts`），命令 `pnpm test -- im.gateway`，无 `--filter test` 脚本。②`session.title` 是否在 `findOrNull` 返回类型上——Task 4 Step 3 已给 `?? ""` 兜底。③`markRead` 仅 `server-main im.gateway:207` 一处调用，改返回类型 `void→Date` 安全。
