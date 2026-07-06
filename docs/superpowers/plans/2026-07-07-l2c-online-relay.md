# L2c · 跨设备在线 relay 查看会话 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 在 L2a 保留的 relay/`device:${id}` 房间/presence 上,新建只读「设备查询」请求-响应协议,让 A 设备经云 relay 拉取在线 B 设备的会话列表并只读查看某会话历史。

**Architecture:** web-agent →(HTTP)A server-agent `RemoteDeviceQueryService`(correlationId + 超时,镜像 ConfirmationService)→(relay WS `device.query.request`)云 `ImGateway`(同账号 + `isOnline` 门控 + 定向下发)→ B server-agent(`account.run` scope 查本地 Session)→ `device.query.response` 原路返回。

**Tech Stack:** NestJS / socket.io / Zod / Jest / jotai / axios。

## Global Constraints

- 设计真相源:`docs/superpowers/specs/2026-07-07-l2c-online-relay-design.md`。
- 事件名前缀 `device.query.`;跨域 schema 放 `libs/types`(禁依赖 NestJS/TypeORM/types-agent)。
- 身份用现有 device token WS 鉴权(`client.data.user.{userId,deviceId}`);跨账号校验 `targetDevice.userId === requester.userId`;`isOnline` 用 **targetDevice.orgId**(presence 按 orgId 存)。
- B 侧本地查询必须在 `account.run(cloudUserId)` 内(ScopedRepository 自动按 cloud_user_id 隔离)。
- 只读:不发消息、不触发远程 run(L3)。
- relay 传输层保持纯净:`ImRelayClientService` 只收发 socket 事件 + `account.run` 包裹后经 `EventEmitter2` 桥到进程内(与现有下行桥一致);查询逻辑在独立 service。
- 跑单 jest 从仓库根:`pnpm exec jest <path>`(**不要** `pnpm --filter … exec jest`)。typecheck 用 `pnpm --filter @meshbot/<pkg> exec tsc --noEmit`。
- 公开方法中文 JSDoc;`if` 前一行不放注释;新错误码走 `defineErrorCode` 且过 `check:error-code`(顺序无 gap/dup)。
- 每 Task 结束 `pnpm check` + 相关测试;commit 中文 conventional commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。只 commit,不 push。

## File Structure

- `libs/types/src/im/im.events.ts` + `im.schema.ts` — 事件名 + Zod schema/类型(Task 1)。
- `apps/server-main/src/ws/im.gateway.ts` + `im.gateway.spec.ts` — 两个 handler(Task 2)。
- `apps/server-agent/src/cloud/remote-device-query.service.ts`(新)+ `.spec.ts` — A 侧 correlation(Task 3)。
- `apps/server-agent/src/cloud/im-relay-client.service.ts` — 出/入站接线(Task 3 出站 + Task 4 入站)。
- `apps/server-agent/src/controllers/remote-device.controller.ts`(新)— A 侧 HTTP(Task 3)。
- `apps/server-agent/src/services/remote-query-inbound.service.ts`(新)+ `.spec.ts` — B 侧查本地(Task 4)。
- `apps/server-agent/src/errors/agent.error-codes.ts` — 新错误码(Task 3)。
- `apps/web-agent/src/rest/remote-devices.ts`(新)+ `atoms/remote-sessions.ts`(新)+ `components/shell/device-node.tsx` + 只读历史视图(Task 5)。

---

### Task 1: 事件契约(libs/types)

**Files:**
- Modify: `libs/types/src/im/im.events.ts`
- Modify: `libs/types/src/im/im.schema.ts`
- Test: `libs/types/src/im/device-query.schema.spec.ts`(新)

**Interfaces — Produces:** `IM_WS_EVENTS.deviceQueryRequest/deviceQueryResponse`;`DeviceQueryRequestSchema`/`DeviceQueryRequestInput`/`DeviceQueryKind`/`DeviceQueryForwarded`/`DeviceQueryResponse`。供 Task 2/3/4 共用。

- [ ] **Step 1: 写失败的 schema 单测**

Create `libs/types/src/im/device-query.schema.spec.ts`:
```ts
import { DeviceQueryRequestSchema } from "./im.schema";

describe("DeviceQueryRequestSchema", () => {
  it("接受 sessions 查询(params 缺省)", () => {
    const r = DeviceQueryRequestSchema.parse({
      correlationId: "c1",
      targetDeviceId: "d2",
      kind: "sessions",
    });
    expect(r.params).toEqual({});
  });

  it("接受 history 查询带游标", () => {
    const r = DeviceQueryRequestSchema.parse({
      correlationId: "c1",
      targetDeviceId: "d2",
      kind: "history",
      params: { sessionId: "s1", before: "m9", limit: 30 },
    });
    expect(r.params.sessionId).toBe("s1");
  });

  it("拒绝非法 kind", () => {
    expect(() =>
      DeviceQueryRequestSchema.parse({
        correlationId: "c1",
        targetDeviceId: "d2",
        kind: "delete",
      }),
    ).toThrow();
  });

  it("拒绝 limit 超界", () => {
    expect(() =>
      DeviceQueryRequestSchema.parse({
        correlationId: "c1",
        targetDeviceId: "d2",
        kind: "history",
        params: { limit: 999 },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec jest libs/types/src/im/device-query.schema.spec.ts`
Expected: FAIL —— `DeviceQueryRequestSchema` 不存在。

- [ ] **Step 3: 加事件名**

在 `libs/types/src/im/im.events.ts` 的 `IM_WS_EVENTS` 对象内(现有 `presenceSet` 后)追加:
```ts
  deviceQueryRequest: "device.query.request",
  deviceQueryResponse: "device.query.response",
```

- [ ] **Step 4: 加 schema/类型**

在 `libs/types/src/im/im.schema.ts` 末尾追加(确认顶部已 `import { z } from "zod"`):
```ts
/** 跨设备只读查询的种类:列会话 / 取某会话历史 */
export const DeviceQueryKindSchema = z.enum(["sessions", "history"]);
export type DeviceQueryKind = z.infer<typeof DeviceQueryKindSchema>;

/** A→云 的设备查询请求(上行,需服务端校验) */
export const DeviceQueryRequestSchema = z.object({
  correlationId: z.string().min(1),
  targetDeviceId: z.string().min(1),
  kind: DeviceQueryKindSchema,
  params: z
    .object({
      sessionId: z.string().optional(),
      before: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .default({}),
});
export type DeviceQueryRequestInput = z.infer<typeof DeviceQueryRequestSchema>;

/** 云网关转发给目标设备时附加发起方 deviceId */
export interface DeviceQueryForwarded extends DeviceQueryRequestInput {
  requesterDeviceId: string;
}

/** 设备查询响应(B→云→A);data 按 kind 由 A 侧断言(sessions→SessionSummary[] / history→HistoryResponse) */
export interface DeviceQueryResponse {
  correlationId: string;
  requesterDeviceId: string;
  ok: boolean;
  reason?: "offline" | "cross_account" | "error";
  data?: unknown;
}
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `pnpm exec jest libs/types/src/im/device-query.schema.spec.ts`
Expected: PASS(4 passed)。
Run: `pnpm --filter @meshbot/types exec tsc --noEmit`
Expected: 无错误。(确认 `@meshbot/types` barrel 已 re-export im.schema/im.events;若这两个文件已被 `src/index.ts` 或 `src/im/index.ts` 导出则新符号自动可见,否则补导出。)

- [ ] **Step 6: commit**

```bash
git add libs/types/src/im/im.events.ts libs/types/src/im/im.schema.ts libs/types/src/im/device-query.schema.spec.ts
git commit -m "feat(types): 加 device.query 请求-响应事件契约(L2c)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: server-main 网关路由 + 门控

**Files:**
- Modify: `apps/server-main/src/ws/im.gateway.ts`
- Test: `apps/server-main/src/ws/im.gateway.spec.ts`

**Interfaces — Consumes:** Task 1 事件/类型;现有 `DeviceService.findById`([device.service.ts:93-95](../../../libs/main/src/services/device.service.ts#L93-L95))、`DevicePresenceService.isOnline`([device-presence.service.ts:102](../../../libs/main/src/services/device-presence.service.ts#L102))。**Produces:** 两个 `@SubscribeMessage`,供两侧 relay 联通。

- [ ] **Step 1: 扩展 makeGateway mock + 写失败测试**

在 `im.gateway.spec.ts` 的 `makeGateway` 里:给 `devices` 覆盖项加 `findById?: jest.Mock`(默认 `jest.fn().mockResolvedValue(undefined)`),给 `devicePresence` 覆盖项加 `isOnline?: jest.Mock`(默认 `jest.fn().mockResolvedValue(true)`);构造 `devices`/`devicePresence` 时带上它们。然后在文件末尾追加:
```ts
describe("ImGateway.handleDeviceQueryRequest(L2c 路由 + 门控)", () => {
  it("同账号 + 在线 → 定向下发到 device:target(附 requesterDeviceId)", async () => {
    const findById = jest.fn().mockResolvedValue({ id: "dB", userId: "u1", orgId: "oB" });
    const isOnline = jest.fn().mockResolvedValue(true);
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      devices: { findById },
      devicePresence: { isOnline },
    });
    const client = { data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } } };
    await gw.handleDeviceQueryRequest(
      { correlationId: "c1", targetDeviceId: "dB", kind: "sessions", params: {} } as never,
      client as never,
    );
    expect(isOnline).toHaveBeenCalledWith("oB", "dB");
    expect(toSpy).toHaveBeenCalledWith("device:dB");
    expect(roomEmitSpy).toHaveBeenCalledWith("device.query.request", {
      correlationId: "c1", targetDeviceId: "dB", kind: "sessions", params: {}, requesterDeviceId: "dA",
    });
  });

  it("跨账号 → 回 ok:false cross_account 给 requester,不下发", async () => {
    const findById = jest.fn().mockResolvedValue({ id: "dB", userId: "u2", orgId: "oB" });
    const { gw, toSpy, roomEmitSpy } = makeGateway({ devices: { findById } });
    const client = { data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } } };
    await gw.handleDeviceQueryRequest(
      { correlationId: "c1", targetDeviceId: "dB", kind: "sessions", params: {} } as never,
      client as never,
    );
    expect(toSpy).toHaveBeenCalledWith("device:dA");
    expect(roomEmitSpy).toHaveBeenCalledWith("device.query.response", {
      correlationId: "c1", requesterDeviceId: "dA", ok: false, reason: "cross_account",
    });
    expect(toSpy).not.toHaveBeenCalledWith("device:dB");
  });

  it("离线 → 回 ok:false offline", async () => {
    const findById = jest.fn().mockResolvedValue({ id: "dB", userId: "u1", orgId: "oB" });
    const isOnline = jest.fn().mockResolvedValue(false);
    const { gw, toSpy, roomEmitSpy } = makeGateway({
      devices: { findById },
      devicePresence: { isOnline },
    });
    const client = { data: { orgId: "oA", user: { userId: "u1", deviceId: "dA" } } };
    await gw.handleDeviceQueryRequest(
      { correlationId: "c1", targetDeviceId: "dB", kind: "sessions", params: {} } as never,
      client as never,
    );
    expect(roomEmitSpy).toHaveBeenCalledWith("device.query.response", {
      correlationId: "c1", requesterDeviceId: "dA", ok: false, reason: "offline",
    });
  });

  it("非设备连接(无 deviceId)→ 不下发", async () => {
    const findById = jest.fn();
    const { gw, toSpy } = makeGateway({ devices: { findById } });
    const client = { data: { orgId: "oA", user: { userId: "u1" } } };
    await gw.handleDeviceQueryRequest(
      { correlationId: "c1", targetDeviceId: "dB", kind: "sessions", params: {} } as never,
      client as never,
    );
    expect(findById).not.toHaveBeenCalled();
    expect(toSpy).not.toHaveBeenCalled();
  });
});

describe("ImGateway.handleDeviceQueryResponse(L2c 回流路由)", () => {
  it("定向回 device:requesterDeviceId", async () => {
    const { gw, toSpy, roomEmitSpy } = makeGateway({});
    const body = { correlationId: "c1", requesterDeviceId: "dA", ok: true, data: [] };
    await gw.handleDeviceQueryResponse(body as never, { data: { user: { deviceId: "dB" } } } as never);
    expect(toSpy).toHaveBeenCalledWith("device:dA");
    expect(roomEmitSpy).toHaveBeenCalledWith("device.query.response", body);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec jest apps/server-main/src/ws/im.gateway.spec.ts`
Expected: FAIL —— `handleDeviceQueryRequest`/`handleDeviceQueryResponse` 不存在。

- [ ] **Step 3: 实现两个 handler**

在 `im.gateway.ts` 类内(照 `handleRead` 位置)新增(确认已 import `IM_WS_EVENTS`、`DeviceQueryRequestInput`、`DeviceQueryResponse` from `@meshbot/types`,`WsAuthGuard` 已 import):
```ts
  /** L2c:A 发起设备查询 → 校验同账号 + 在线 → 定向下发到目标设备 */
  @SubscribeMessage(IM_WS_EVENTS.deviceQueryRequest)
  @UseGuards(WsAuthGuard)
  async handleDeviceQueryRequest(
    @MessageBody() body: DeviceQueryRequestInput,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const requester = client.data.user as { userId?: string; deviceId?: string };
    if (!requester?.deviceId) return;
    const reply = (reason: DeviceQueryResponse["reason"]) =>
      this.server.to(`device:${requester.deviceId}`).emit(IM_WS_EVENTS.deviceQueryResponse, {
        correlationId: body.correlationId,
        requesterDeviceId: requester.deviceId,
        ok: false,
        reason,
      } satisfies DeviceQueryResponse);
    const target = await this.devices.findById(body.targetDeviceId);
    if (!target || target.userId !== requester.userId) {
      reply("cross_account");
      return;
    }
    const online = await this.devicePresence.isOnline(target.orgId ?? "", target.id);
    if (!online) {
      reply("offline");
      return;
    }
    this.server.to(`device:${target.id}`).emit(IM_WS_EVENTS.deviceQueryRequest, {
      ...body,
      requesterDeviceId: requester.deviceId,
    });
  }

  /** L2c:目标设备回流 → 按 requesterDeviceId 定向回发起方 */
  @SubscribeMessage(IM_WS_EVENTS.deviceQueryResponse)
  @UseGuards(WsAuthGuard)
  async handleDeviceQueryResponse(
    @MessageBody() body: DeviceQueryResponse,
    @ConnectedSocket() _client: Socket,
  ): Promise<void> {
    this.server.to(`device:${body.requesterDeviceId}`).emit(IM_WS_EVENTS.deviceQueryResponse, body);
  }
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm exec jest apps/server-main/src/ws/im.gateway.spec.ts`
Expected: PASS(原有用例 + 新增 5 例全绿)。
Run: `pnpm --filter @meshbot/server-main exec tsc --noEmit` → 无错误。

- [ ] **Step 5: commit**

```bash
git add apps/server-main/src/ws/im.gateway.ts apps/server-main/src/ws/im.gateway.spec.ts
git commit -m "feat(server-main): 网关 device.query 路由 + 同账号/在线门控(L2c)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: server-agent A 侧出站(query service + controller + relay 出站/响应接线)

**Files:**
- Create: `apps/server-agent/src/cloud/remote-device-query.service.ts`
- Test: `apps/server-agent/src/cloud/remote-device-query.service.spec.ts`
- Modify: `apps/server-agent/src/cloud/im-relay-client.service.ts`(出站 `emitDeviceQuery` + 下行 `deviceQueryResponse` 桥)
- Create: `apps/server-agent/src/controllers/remote-device.controller.ts`
- Modify: `apps/server-agent/src/errors/agent.error-codes.ts`(新错误码)
- Modify: `apps/server-agent/src/auth.module.ts`(注册新 provider/controller)

**Interfaces — Consumes:** Task 1 类型;`ImRelayClientService`。**Produces:** `RemoteDeviceQueryService.query(cloudUserId, targetDeviceId, kind, params, timeoutMs?)` + `settle(res)`;HTTP `/api/remote-devices/:id/sessions[/:sessionId/history]`;本地事件 `IM_RELAY_EVENTS.deviceQueryRequest`(供 Task 4 入站消费)。

- [ ] **Step 1: 加错误码**

在 `apps/server-agent/src/errors/agent.error-codes.ts` 按现有 `defineErrorCode` 模式追加两个(读文件确认当前最大码,取**下一顺序号**,无 gap):
```ts
  REMOTE_QUERY_TIMEOUT: defineErrorCode(<next>, "远程设备查询超时", 504),
  REMOTE_QUERY_UNAVAILABLE: defineErrorCode(<next+1>, "远程设备不可用(离线或跨账号)", 409),
```
(具体 code 数值由实现者按文件现状填;HTTP 状态如上。)

- [ ] **Step 2: 写失败的 query service 单测**

Create `apps/server-agent/src/cloud/remote-device-query.service.spec.ts`:
```ts
import { AppError } from "@meshbot/common";
import { RemoteDeviceQueryService } from "./remote-device-query.service";

function make() {
  const relay = { emitDeviceQuery: jest.fn() };
  const svc = new RemoteDeviceQueryService(relay as never);
  return { svc, relay };
}

describe("RemoteDeviceQueryService", () => {
  it("settle(ok:true) 在超时前到达 → resolve data", async () => {
    const { svc, relay } = make();
    const p = svc.query("u1", "dB", "sessions", {});
    const corr = relay.emitDeviceQuery.mock.calls[0][1].correlationId as string;
    svc.settle({ correlationId: corr, requesterDeviceId: "dA", ok: true, data: [{ id: "s1" }] });
    await expect(p).resolves.toEqual([{ id: "s1" }]);
  });

  it("超时 → reject REMOTE_QUERY_TIMEOUT", async () => {
    jest.useFakeTimers();
    const { svc } = make();
    const p = svc.query("u1", "dB", "sessions", {}, 8000);
    const assertion = expect(p).rejects.toBeInstanceOf(AppError);
    jest.advanceTimersByTime(8000);
    await assertion;
    jest.useRealTimers();
  });

  it("settle(ok:false, offline) → reject", async () => {
    const { svc, relay } = make();
    const p = svc.query("u1", "dB", "sessions", {});
    const corr = relay.emitDeviceQuery.mock.calls[0][1].correlationId as string;
    svc.settle({ correlationId: corr, requesterDeviceId: "dA", ok: false, reason: "offline" });
    await expect(p).rejects.toBeInstanceOf(AppError);
  });

  it("emitDeviceQuery 抛错(未连接)→ query 抛错且不泄漏 pending", async () => {
    const relay = { emitDeviceQuery: jest.fn(() => { throw new Error("not connected"); }) };
    const svc = new RemoteDeviceQueryService(relay as never);
    await expect(svc.query("u1", "dB", "sessions", {})).rejects.toThrow();
    // 未知 correlation settle 应 no-op(不抛)
    expect(() => svc.settle({ correlationId: "x", requesterDeviceId: "dA", ok: true, data: 1 })).not.toThrow();
  });

  it("settle 未知 correlationId → no-op", () => {
    const { svc } = make();
    expect(() => svc.settle({ correlationId: "nope", requesterDeviceId: "dA", ok: true, data: 1 })).not.toThrow();
  });
});
```

- [ ] **Step 3: 跑确认失败**

Run: `pnpm exec jest apps/server-agent/src/cloud/remote-device-query.service.spec.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现 query service**

Create `apps/server-agent/src/cloud/remote-device-query.service.ts`:
```ts
import { randomBytes } from "node:crypto";
import { AppError } from "@meshbot/common";
import type {
  DeviceQueryKind,
  DeviceQueryRequestInput,
  DeviceQueryResponse,
} from "@meshbot/types";
import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { IM_RELAY_EVENTS } from "./im-relay-events";
import { ImRelayClientService } from "./im-relay-client.service";

interface Pending {
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** L2c A 侧:发起跨设备查询,按 correlationId 等待 relay 回流(镜像 ConfirmationService) */
@Injectable()
export class RemoteDeviceQueryService {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly relay: ImRelayClientService) {}

  /** 发起对目标设备的只读查询;超时/离线/跨账号 → reject */
  async query(
    cloudUserId: string,
    targetDeviceId: string,
    kind: DeviceQueryKind,
    params: DeviceQueryRequestInput["params"],
    timeoutMs = 8000,
  ): Promise<unknown> {
    const correlationId = randomBytes(16).toString("hex");
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new AppError(AgentErrorCode.REMOTE_QUERY_TIMEOUT));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(correlationId, { resolve, reject, timer });
    });
    try {
      this.relay.emitDeviceQuery(cloudUserId, { correlationId, targetDeviceId, kind, params });
    } catch (e) {
      this.clear(correlationId);
      throw e;
    }
    return result;
  }

  /** relay 收到 device.query.response 时经本地事件回调 */
  @OnEvent(IM_RELAY_EVENTS.deviceQueryResponse)
  settle(res: DeviceQueryResponse): void {
    const entry = this.pending.get(res.correlationId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(res.correlationId);
    if (res.ok) entry.resolve(res.data);
    else entry.reject(new AppError(AgentErrorCode.REMOTE_QUERY_UNAVAILABLE));
  }

  private clear(correlationId: string): void {
    const entry = this.pending.get(correlationId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(correlationId);
  }
}
```
> 若 `im-relay-events.ts`(本地 `IM_RELAY_EVENTS` 常量)不存在,读 `im-relay-client.service.ts` 里现有 `IM_RELAY_EVENTS`(报告提到 `IM_RELAY_EVENTS.connected`)的定义处,在其中加 `deviceQueryRequest`/`deviceQueryResponse` 两个本地事件名。

- [ ] **Step 5: relay 出站 + 响应桥接线**

在 `im-relay-client.service.ts`:
- 加出站方法(照 `send()` L244-250):
```ts
  /** L2c:发起设备查询(未连接抛 IM_NOT_CONNECTED) */
  emitDeviceQuery(cloudUserId: string, payload: DeviceQueryRequestInput): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn) throw new AppError(AgentErrorCode.IM_NOT_CONNECTED);
    conn.socket.emit(IM_WS_EVENTS.deviceQueryRequest, payload);
  }

  /** L2c:B 侧回发响应 */
  emitDeviceQueryResponse(cloudUserId: string, payload: DeviceQueryResponse): void {
    const conn = this.conns.get(cloudUserId);
    if (!conn) return;
    conn.socket.emit(IM_WS_EVENTS.deviceQueryResponse, payload);
  }
```
- 在 `connect()` 里注册两个下行订阅(现有下行 for-loop 之后,单独 `socket.on`):
```ts
    socket.on(IM_WS_EVENTS.deviceQueryResponse, (payload: DeviceQueryResponse) => {
      this.account.run(cloudUserId, () => this.emitter.emit(IM_RELAY_EVENTS.deviceQueryResponse, payload));
    });
    socket.on(IM_WS_EVENTS.deviceQueryRequest, (payload: DeviceQueryForwarded) => {
      this.account.run(cloudUserId, () =>
        this.emitter.emit(IM_RELAY_EVENTS.deviceQueryRequest, { cloudUserId, forwarded: payload }),
      );
    });
```
(补 import `DeviceQueryRequestInput`/`DeviceQueryResponse`/`DeviceQueryForwarded` from `@meshbot/types`。)

- [ ] **Step 6: HTTP controller**

Create `apps/server-agent/src/controllers/remote-device.controller.ts`(照现有 `cloud-im.controller.ts` `@Controller("api")` + `AccountContextService` 取账号):
```ts
import type { HistoryResponse, SessionSummary } from "@meshbot/types-agent";
import { Controller, Get, Param, Query } from "@nestjs/common";
import { AccountContextService } from "../account/…"; // 与 cloud-im.controller 同源
import { RemoteDeviceQueryService } from "../cloud/remote-device-query.service";

/** L2c:向本地 server-agent 发起「查在线远程设备会话」的 HTTP 入口 */
@Controller("api")
export class RemoteDeviceController {
  constructor(
    private readonly query: RemoteDeviceQueryService,
    private readonly account: AccountContextService,
  ) {}

  @Get("remote-devices/:id/sessions")
  async sessions(@Param("id") id: string): Promise<SessionSummary[]> {
    const acct = this.account.getOrThrow();
    return (await this.query.query(acct, id, "sessions", {})) as SessionSummary[];
  }

  @Get("remote-devices/:id/sessions/:sessionId/history")
  async history(
    @Param("id") id: string,
    @Param("sessionId") sessionId: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
  ): Promise<HistoryResponse> {
    const acct = this.account.getOrThrow();
    return (await this.query.query(acct, id, "history", {
      sessionId,
      before,
      limit: limit ? Number(limit) : undefined,
    })) as HistoryResponse;
  }
}
```
> 读 `cloud-im.controller.ts` 确认 `AccountContextService` 的实际 import 路径与「取当前账号」的确切方法名(可能是 `getOrThrow()` 或经守卫注入),照抄。

- [ ] **Step 7: 注册 provider/controller**

在 `apps/server-agent/src/auth.module.ts`(`ImRelayClientService` 所在模块)的 `providers` 加 `RemoteDeviceQueryService`,`controllers` 加 `RemoteDeviceController`(读该模块确认 controllers 数组位置;若 controller 归属别的 module 则加到对应处)。

- [ ] **Step 8: 跑测试 + typecheck + commit**

Run: `pnpm exec jest apps/server-agent/src/cloud/remote-device-query.service.spec.ts` → PASS(5)。
Run: `pnpm --filter @meshbot/server-agent exec tsc --noEmit` → 无错误。
Run: `pnpm check:error-code` → 0 问题。
```bash
git add apps/server-agent/src/cloud/remote-device-query.service.ts apps/server-agent/src/cloud/remote-device-query.service.spec.ts apps/server-agent/src/cloud/im-relay-client.service.ts apps/server-agent/src/controllers/remote-device.controller.ts apps/server-agent/src/errors/agent.error-codes.ts apps/server-agent/src/auth.module.ts
git commit -m "feat(server-agent): L2c A 侧设备查询出站(correlation+超时 + HTTP 入口)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: server-agent B 侧入站(account.run 查本地会话)

**Files:**
- Create: `apps/server-agent/src/services/remote-query-inbound.service.ts`
- Test: `apps/server-agent/src/services/remote-query-inbound.service.spec.ts`
- Modify: `apps/server-agent/src/auth.module.ts`(或 session 相关 module)注册 provider

**Interfaces — Consumes:** 本地事件 `IM_RELAY_EVENTS.deviceQueryRequest`(Task 3 relay 发出,payload `{cloudUserId, forwarded: DeviceQueryForwarded}`);`SessionService.listAllSorted`、`SessionMessageService.listPage`;`AccountContextService.run`;`ImRelayClientService.emitDeviceQueryResponse`。

- [ ] **Step 1: 写失败的入站单测**

Create `apps/server-agent/src/services/remote-query-inbound.service.spec.ts`:
```ts
import { RemoteQueryInboundService } from "./remote-query-inbound.service";

function make() {
  const sessions = { listAllSorted: jest.fn().mockResolvedValue([{ id: "s1", title: "t" }]) };
  const messages = { listPage: jest.fn().mockResolvedValue({ messages: [{ id: "m1", role: "user", content: "hi" }], hasMore: false }) };
  const relay = { emitDeviceQueryResponse: jest.fn() };
  const account = { run: jest.fn(async (_uid: string, fn: () => Promise<void>) => fn()) };
  const svc = new RemoteQueryInboundService(sessions as never, messages as never, relay as never, account as never);
  return { svc, sessions, messages, relay, account };
}
const fwd = (over: object) => ({ cloudUserId: "u1", forwarded: { correlationId: "c1", requesterDeviceId: "dA", targetDeviceId: "dB", kind: "sessions", params: {}, ...over } });

describe("RemoteQueryInboundService", () => {
  it("kind=sessions → account.run 内查会话并回 ok:true", async () => {
    const { svc, sessions, relay, account } = make();
    await svc.onDeviceQueryRequest(fwd({}) as never);
    expect(account.run).toHaveBeenCalledWith("u1", expect.any(Function));
    expect(sessions.listAllSorted).toHaveBeenCalled();
    expect(relay.emitDeviceQueryResponse).toHaveBeenCalledWith("u1", {
      correlationId: "c1", requesterDeviceId: "dA", ok: true, data: [{ id: "s1", title: "t" }],
    });
  });

  it("kind=history → listPage(sessionId, {before,limit}) 并回 HistoryResponse", async () => {
    const { svc, messages, relay } = make();
    await svc.onDeviceQueryRequest(fwd({ kind: "history", params: { sessionId: "s1", before: "m9", limit: 30 } }) as never);
    expect(messages.listPage).toHaveBeenCalledWith("s1", { before: "m9", limit: 30 });
    const call = relay.emitDeviceQueryResponse.mock.calls[0][1];
    expect(call.ok).toBe(true);
    expect(call.data.messages[0].id).toBe("m1");
  });

  it("查询抛错 → 回 ok:false error", async () => {
    const { svc, sessions, relay } = make();
    sessions.listAllSorted.mockRejectedValueOnce(new Error("boom"));
    await svc.onDeviceQueryRequest(fwd({}) as never);
    expect(relay.emitDeviceQueryResponse).toHaveBeenCalledWith("u1", expect.objectContaining({ ok: false, reason: "error" }));
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm exec jest apps/server-agent/src/services/remote-query-inbound.service.spec.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现入站 service**

Create `apps/server-agent/src/services/remote-query-inbound.service.ts`:
```ts
import { AccountContextService } from "@meshbot/agent"; // 与 session.service 同源;实现者按实际 import 路径校正
import type { DeviceQueryForwarded, DeviceQueryResponse } from "@meshbot/types";
import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { IM_RELAY_EVENTS } from "../cloud/im-relay-events";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";

/** L2c B 侧:收到跨设备查询 → 在 account.run scope 内查本地会话 → 回发响应 */
@Injectable()
export class RemoteQueryInboundService {
  constructor(
    private readonly sessions: SessionService,
    private readonly messages: SessionMessageService,
    private readonly relay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {}

  @OnEvent(IM_RELAY_EVENTS.deviceQueryRequest)
  async onDeviceQueryRequest(evt: { cloudUserId: string; forwarded: DeviceQueryForwarded }): Promise<void> {
    const { cloudUserId, forwarded } = evt;
    const base = { correlationId: forwarded.correlationId, requesterDeviceId: forwarded.requesterDeviceId };
    try {
      await this.account.run(cloudUserId, async () => {
        const data =
          forwarded.kind === "sessions"
            ? await this.sessions.listAllSorted()
            : await this.messages.listPage(forwarded.params.sessionId ?? "", {
                before: forwarded.params.before,
                limit: forwarded.params.limit ?? 50,
              });
        this.relay.emitDeviceQueryResponse(cloudUserId, { ...base, ok: true, data } satisfies DeviceQueryResponse);
      });
    } catch {
      this.relay.emitDeviceQueryResponse(cloudUserId, { ...base, ok: false, reason: "error" });
    }
  }
}
```
> `AccountContextService` 与 `listPage` 返回类型的确切 import/形状:读 `session.service.ts`/`session-message.service.ts` 顶部 import 校正(报告:`AccountContextService` from `@meshbot/agent`,`listPage` 返回 `SessionMessagePage`)。history 若需与本地 `HistoryResponse` 完全同构,按需在此映射(至少含 `messages`/`hasMore`)。

- [ ] **Step 4: 注册 provider**

在 `RemoteQueryInboundService` 所依赖 service 所在的 module(SessionService/SessionMessageService 与 ImRelayClientService 需同一注入图可达)的 `providers` 注册它。读 module 结构确认放哪个 module(可能需在 auth.module 或 session module,取决于 ImRelayClientService 的可见性;若跨 module,经 exports 打通)。

- [ ] **Step 5: 跑测试 + typecheck + commit**

Run: `pnpm exec jest apps/server-agent/src/services/remote-query-inbound.service.spec.ts` → PASS(3)。
Run: `pnpm --filter @meshbot/server-agent exec tsc --noEmit` → 无错误。
```bash
git add apps/server-agent/src/services/remote-query-inbound.service.ts apps/server-agent/src/services/remote-query-inbound.service.spec.ts apps/server-agent/src/auth.module.ts
git commit -m "feat(server-agent): L2c B 侧入站查本地会话(account.run scope)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: web-agent 只读 UI

**Files:**
- Create: `apps/web-agent/src/rest/remote-devices.ts`
- Create: `apps/web-agent/src/atoms/remote-sessions.ts`
- Modify: `apps/web-agent/src/components/shell/device-node.tsx`
- Modify: `apps/web-agent/src/components/session/message-list.tsx`(加 `readOnly` prop)
- 只读历史视图:在 `app/(shell)/assistant/page.tsx` 支持 `?remoteDevice=<id>` 分支,或新增只读组件(实现者择一,复用 `MessageList` + `historyMessageToTimeline`)
- Modify: `apps/web-agent/messages/{zh,en}.json`(新增文案)

**Interfaces — Consumes:** Task 3 HTTP `/api/remote-devices/:id/sessions[/:sessionId/history]`;`DeviceView`、`SessionSummary`、`HistoryResponse`;`MessageList`、`historyMessageToTimeline`。

> **说明**:web-agent 无组件测试基建(root jest node 环境无 jsdom,`lib/*.ts` 零 import 纪律)。本 Task 以 **typecheck + build + 目视** 验证为主,不写组件单测。

- [ ] **Step 1: rest**

Create `apps/web-agent/src/rest/remote-devices.ts`(照 `rest/devices.ts`,用 `apiClient`):
```ts
import { apiClient } from "@meshbot/web-common/api";
import type { SessionSummary, HistoryResponse } from "@meshbot/types-agent";

/** 拉取在线远程设备的会话列表(经本地 server-agent → relay) */
export async function fetchRemoteSessions(deviceId: string): Promise<SessionSummary[]> {
  return apiClient.get(`/api/remote-devices/${deviceId}/sessions`);
}

/** 拉取远程设备某会话历史(只读) */
export async function fetchRemoteHistory(
  deviceId: string,
  sessionId: string,
  opts?: { before?: string; limit?: number },
): Promise<HistoryResponse> {
  const q = new URLSearchParams();
  if (opts?.before) q.set("before", opts.before);
  if (opts?.limit) q.set("limit", String(opts.limit));
  const qs = q.toString();
  return apiClient.get(
    `/api/remote-devices/${deviceId}/sessions/${sessionId}/history${qs ? `?${qs}` : ""}`,
  );
}
```
(确认 `apiClient` 的实际 import 路径与 `rest/devices.ts` 一致。)

- [ ] **Step 2: atom(按设备缓存,不污染本地 sessionsAtom)**

Create `apps/web-agent/src/atoms/remote-sessions.ts`:
```ts
import type { SessionSummary } from "@meshbot/types-agent";
import { atom } from "jotai";
import { fetchRemoteSessions } from "@/rest/remote-devices";

type RemoteState = { status: "idle" | "loading" | "loaded" | "error"; sessions: SessionSummary[] };
/** deviceId → 该远程设备的会话加载态 */
export const remoteSessionsAtom = atom<Record<string, RemoteState>>({});

/** 按需加载某远程设备会话(已 loaded/loading 跳过) */
export const loadRemoteSessionsAtom = atom(null, async (get, set, deviceId: string) => {
  const cur = get(remoteSessionsAtom)[deviceId];
  if (cur && cur.status !== "idle" && cur.status !== "error") return;
  set(remoteSessionsAtom, (m) => ({ ...m, [deviceId]: { status: "loading", sessions: [] } }));
  try {
    const sessions = await fetchRemoteSessions(deviceId);
    set(remoteSessionsAtom, (m) => ({ ...m, [deviceId]: { status: "loaded", sessions } }));
  } catch {
    set(remoteSessionsAtom, (m) => ({ ...m, [deviceId]: { status: "error", sessions: [] } }));
  }
});
```

- [ ] **Step 3: device-node.tsx 换占位**

改 [device-node.tsx:68-72](../../../apps/web-agent/src/components/shell/device-node.tsx#L68-L72) 的「其他设备」分支:展开时 `useSetAtom(loadRemoteSessionsAtom)(device.id)`(在 `onClick` 展开或 `useEffect(open && !isCurrent)` 里触发)+ 展开瞬间重探在线态(`fetchDeviceOnline(device.id)` 写 `deviceOnlineAtom`,解决在线态陈旧);渲染 `remoteSessionsAtom[device.id]`:loading→skeleton、error→文案、loaded→列会话(点击 → 只读历史视图,导航 `/assistant?remoteDevice=${device.id}&id=${s.id}`)。用新的只读会话项(不复用会导航到本地的 `SessionListItem`;可内联一个简单 `<button>` 列表项)。

- [ ] **Step 4: MessageList 只读态 + 只读历史视图**

- 给 `MessageList` 加 `readOnly?: boolean`,为 true 时隐藏 `AssistantMessageActions`/`UserMessageActions`([message-list.tsx:199-220](../../../apps/web-agent/src/components/session/message-list.tsx#L199-L220))(或复用现有 `nested`)。
- 在 `app/(shell)/assistant/page.tsx`:读 `?remoteDevice`;存在时走只读分支——用 `fetchRemoteHistory(remoteDevice, id)` 拉 history,`historyMessageToTimeline` 映射,渲染 `<MessageList readOnly messages=… sessionId=id running={false} onRegenerateOptimisticCut={()=>{}} />`,输入框禁用 + 提示「远程会话,只读」;不存在(本地)时保持现状。**不**调用 `useSessionStream`(耦合本地流)。

- [ ] **Step 5: i18n 文案**

在 `messages/zh.json` + `messages/en.json` 的 `assistantSidebar`(或 composer)加:`remoteReadOnly`(「远程会话,只读」/"Remote session (read-only)")、`remoteLoadFailed`、`remoteEmpty`。保持 zh/en 对称(`pnpm sync:locales -- --check` 会校验)。

- [ ] **Step 6: 校验 + commit**

Run: `pnpm --filter @meshbot/web-agent exec tsc --noEmit`(或 `pnpm build:web-agent`)→ 无类型错误。
Run: `pnpm exec tsx scripts/sync-locales.ts -- --check` → missing=0 asymmetric=0。
目视(需 dev + 第二个 server-agent 实例):助手侧栏展开在线远程设备 → 列会话;点击 → 只读历史(输入禁用);离线设备置灰。
```bash
git add apps/web-agent/src/rest/remote-devices.ts apps/web-agent/src/atoms/remote-sessions.ts apps/web-agent/src/components/shell/device-node.tsx apps/web-agent/src/components/session/message-list.tsx apps/web-agent/src/app/\(shell\)/assistant/page.tsx apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): L2c 助手展开远程设备会话 + 只读历史视图

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 完成后

5 Task 完成 + `pnpm test` 全绿(注:web-agent UI 无组件测试,以 typecheck/build/目视为准)后,用 superpowers:finishing-a-development-branch 收尾:push → PR → CI → 合并。**双设备端到端**靠手工(dev + `pnpm run:local` 打包版同账号两实例)验证「A 展开在线 B → 看到 B 的会话 → 只读打开某会话历史」。

## Self-Review 检查点

- **Spec 覆盖**:事件契约(T1)、网关路由门控(T2)、A 侧出站+HTTP(T3)、B 侧 account.run 查询(T4)、web-agent 只读 UI(T5)——覆盖 spec §3/§4 全部。
- **类型一致**:`DeviceQueryRequestInput`(T1)→ relay emit(T3)→ 网关转发注入 requesterDeviceId(T2)→ B 入站 `DeviceQueryForwarded`(T4)→ `DeviceQueryResponse`(T1)→ A settle(T3)→ HTTP → web rest(T5),贯穿一致。
- **安全/scope**:网关同账号+在线门控(T2);B 侧 `account.run` scope(T4);只读(T5)。
- **降级**:离线/跨账号/超时 → reject → HTTP 409/504(T3);展开重探在线态(T5)。
- **风险**:双设备 e2e 难 → 以各端单测 + 手工双实例覆盖(spec §6/§8)。
```
