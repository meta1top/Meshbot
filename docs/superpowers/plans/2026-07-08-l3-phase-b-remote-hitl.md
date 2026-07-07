# L3 Phase B 远程 HITL 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 A 设备远程会话里 B 的 agent 发起的工具确认/提问,能在 A 前端点确认/拒绝/回答,决定经 relay 控制帧回 B 进程内 resolve 挂起的工具;并把「A 可靠得知当前 run 的 streamId↔sessionId」收敛为查 A 本机。

**Architecture:** 复用 Phase A 已铺的控制通路(control 协议 kind 已含 confirm/answer/interrupt、云网关按 streamId 路由+发起方校验、A sendControl、B relay 下行)。补最后一公里:①线路 answers 升级承载结构化答案;②B 侧 confirm/answer 真 resolve + streamId↔sessionId 注册表做 M3 校验;③A 侧加控制出口 + 本机只读真源端点;④前端卡片经新 RemoteSessionContext 拿 remoteDeviceId+实时 streamId 走远程端点,create/刷新改查本机。

**Tech Stack:** NestJS(server-agent,SQLite)、Zod(`createI18nZodDto`)、EventEmitter2、Next.js/React(web-agent,Jotai,无组件测试基建)、Jest。

## Global Constraints

- **面向用户对话一律用中文**(全局偏好);公开方法带中文 JSDoc。
- **B 上 run 本体零改**:复用 `SessionService`/`RunnerService`/`ConfirmationService`,不碰 runner/graph/工具实现。
- **relay 传输层保持纯净**:新逻辑走独立 service + `@OnEvent` 桥接。
- **`account.run(cloudUserId)` scope**:B 侧一切 resolve/interrupt 在此上下文内;key 含 cloudUserId(`${cloudUserId}:${sessionId}:${toolCallId}`)。
- **`libs/types` 禁止 import `libs/types-agent`**(依赖方向 types-agent→types,反向成环)。answer-item schema 在 `libs/types` 内**镜像重定义**(加注释说明镜像关系,仓库有先例 `libs/types-agent/src/sidebar.ts:5`)。
- **server-agent HTTP DTO 用 `createI18nZodDto`**(见 `dto/remote-run.dto.ts` 风格),controller 取 cloudUserId 用 `this.account.getOrThrow()`(非 `@Account` 装饰器);`@Controller("api")` 全局 JWT 守卫,不逐端点标 `@Public`。
- **静态围栏必须全绿**:`pnpm check`(tx/naming/lock-tx/repo/scope/dead/error-code/pk/dev-script)+ `pnpm check:dead --strict`;新公开端点补 swagger 注解(`swagger-api-declaration`)。
- **多实例(Phase A I2)仍非目标**:streamId 路由表进程内 Map,单实例可用。
- **跑单 spec 从仓库根**:`pnpm exec jest <path>`(勿 `--filter`);改 `libs/types` 后若 server tsc 报缺导出,先 `pnpm --filter @meshbot/types build`。
- TDD:先写失败测试;频繁提交(中文 conventional commits)。

---

### Task 1: 线路协议 — answers 升级为结构化 AnswerItem[]

**Files:**
- Modify: `libs/types/src/im/im.schema.ts`(`AgentRunControlSchema.answers`)
- Test: `libs/types/src/im/agent-run-control.schema.spec.ts`(新建;若已有 agent-run schema spec 可追加)

**Interfaces:**
- Consumes: 无(纯 schema)。
- Produces:
  - `AgentRunAnswerItemSchema = z.object({ selected: z.array(z.string()), other: z.string().optional() })`(导出)
  - `AgentRunControlSchema.answers: z.array(AgentRunAnswerItemSchema).optional()`(形状变更)
  - `AgentRunControlInput`/`AgentRunControlForwarded` 类型随之更新(`answers?: { selected: string[]; other?: string }[]`)

- [ ] **Step 1: 写失败测试**

在 `libs/types/src/im/agent-run-control.schema.spec.ts`:

```ts
import { AgentRunControlSchema } from "./im.schema";

describe("AgentRunControlSchema", () => {
  it("answer kind 承载结构化 AnswerItem[](含 other)", () => {
    const parsed = AgentRunControlSchema.parse({
      streamId: "s1", targetDeviceId: "d1", sessionId: "sess1",
      kind: "answer", toolCallId: "tc1",
      answers: [{ selected: ["A", "B"], other: "自定义" }, { selected: ["X"] }],
    });
    expect(parsed.answers).toEqual([
      { selected: ["A", "B"], other: "自定义" },
      { selected: ["X"] },
    ]);
  });

  it("confirm kind 带 decision+content", () => {
    const p = AgentRunControlSchema.parse({
      streamId: "s1", targetDeviceId: "d1", sessionId: "sess1",
      kind: "confirm", toolCallId: "tc1", decision: "send", content: "改写",
    });
    expect(p.decision).toBe("send");
  });

  it("interrupt kind 无需 toolCallId", () => {
    expect(() => AgentRunControlSchema.parse({
      streamId: "s1", targetDeviceId: "d1", sessionId: "sess1", kind: "interrupt",
    })).not.toThrow();
  });

  it("answers 里缺 selected → 拒", () => {
    expect(() => AgentRunControlSchema.parse({
      streamId: "s1", targetDeviceId: "d1", sessionId: "sess1",
      kind: "answer", toolCallId: "tc1", answers: [{ other: "x" }],
    })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec jest libs/types/src/im/agent-run-control.schema.spec.ts`
Expected: FAIL(旧 `answers: z.array(z.string())` 会让第 1 个用例解析出的 answers 不等于对象数组 / 或报错)

- [ ] **Step 3: 改 schema**

在 `libs/types/src/im/im.schema.ts`,`AgentRunControlSchema` 定义**之前**加镜像 schema(顶部仅 `import { z } from "zod"`,不 import 任何跨包):

```ts
/**
 * 远程 ask_question 回答项。镜像 `@meshbot/types-agent` 的 `answerItemSchema`
 *（libs/types 不能反向依赖 types-agent,故就地重定义;形状须与其保持一致）。
 */
export const AgentRunAnswerItemSchema = z.object({
  selected: z.array(z.string()),
  other: z.string().optional(),
});
export type AgentRunAnswerItem = z.infer<typeof AgentRunAnswerItemSchema>;
```

把 `AgentRunControlSchema` 里的 `answers: z.array(z.string()).optional()` 改为:

```ts
  answers: z.array(AgentRunAnswerItemSchema).optional(),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec jest libs/types/src/im/agent-run-control.schema.spec.ts`
Expected: PASS(4 用例)

- [ ] **Step 5: 重建 types 产物(下游 tsc 依赖)**

Run: `pnpm --filter @meshbot/types build`
Expected: 成功(dist 更新,后续 Task 的 server tsc 才能看到新形状)

- [ ] **Step 6: 提交**

```bash
git add libs/types/src/im/im.schema.ts libs/types/src/im/agent-run-control.schema.spec.ts
git commit -m "feat(types): agent.run.control answers 升级为结构化 AnswerItem[]"
```

---

### Task 2: B 侧 streamId↔sessionId 注册表(M3 的真源)

**Files:**
- Create: `apps/server-agent/src/services/remote-run-registry.service.ts`
- Test: `apps/server-agent/src/services/remote-run-registry.service.spec.ts`
- Modify: `apps/server-agent/src/services/remote-run-inbound.service.ts`(bind/unbind 挂钩)
- Modify: `apps/server-agent/src/session.module.ts`(provide 新 service)
- Test: `apps/server-agent/src/services/remote-run-inbound.service.spec.ts`(补 bind/unbind 断言)

**Interfaces:**
- Consumes: 无。
- Produces:
  - `class RemoteRunRegistryService`,方法:
    - `bind(streamId: string, sessionId: string): void`
    - `unbind(streamId: string): void`
    - `sessionIdOf(streamId: string): string | undefined`
  - `RemoteRunInboundService.subscribeAndForward` 在拿到 sessionId 后 `registry.bind(streamId, sessionId)`,在 `unsubscribeAll` 时 `registry.unbind(streamId)`。

- [ ] **Step 1: 写失败测试(registry)**

`remote-run-registry.service.spec.ts`:

```ts
import { RemoteRunRegistryService } from "./remote-run-registry.service";

describe("RemoteRunRegistryService", () => {
  let reg: RemoteRunRegistryService;
  beforeEach(() => { reg = new RemoteRunRegistryService(); });

  it("bind 后可反查 sessionId", () => {
    reg.bind("stream-1", "sess-1");
    expect(reg.sessionIdOf("stream-1")).toBe("sess-1");
  });

  it("unbind 后查不到", () => {
    reg.bind("stream-1", "sess-1");
    reg.unbind("stream-1");
    expect(reg.sessionIdOf("stream-1")).toBeUndefined();
  });

  it("未知 streamId 返回 undefined", () => {
    expect(reg.sessionIdOf("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec jest apps/server-agent/src/services/remote-run-registry.service.spec.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 registry**

`remote-run-registry.service.ts`:

```ts
import { Injectable } from "@nestjs/common";

/**
 * B 侧远程 run 的 streamId → sessionId 进程内注册表。
 * 供 RemoteRunControlService 校验「control 帧携带的 sessionId 确属该 streamId 的活跃 run」(M3),
 * 防同账号内跨会话 resolve。纯内存,run 结束即清(与本地 HITL 一致,不持久化)。
 */
@Injectable()
export class RemoteRunRegistryService {
  private readonly streamToSession = new Map<string, string>();

  /** 登记一条活跃远程 run 的 streamId→sessionId 映射。 */
  bind(streamId: string, sessionId: string): void {
    this.streamToSession.set(streamId, sessionId);
  }

  /** 移除映射(run 终止退订时调用)。 */
  unbind(streamId: string): void {
    this.streamToSession.delete(streamId);
  }

  /** 反查 streamId 对应的 sessionId;未登记返 undefined。 */
  sessionIdOf(streamId: string): string | undefined {
    return this.streamToSession.get(streamId);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec jest apps/server-agent/src/services/remote-run-registry.service.spec.ts`
Expected: PASS(3 用例)

- [ ] **Step 5: 接入 RemoteRunInboundService**

`remote-run-inbound.service.ts`:构造注入 `private readonly registry: RemoteRunRegistryService`。在 `subscribeAndForward(cloudUserId, streamId, requesterDeviceId, sessionId)` 内、注册监听器之后加 `this.registry.bind(streamId, sessionId);`;在 `unsubscribeAll()` 内加 `this.registry.unbind(streamId);`(与现有退订同处)。

- [ ] **Step 6: 在 session.module 注册**

`session.module.ts` 的 `providers` 数组加 `RemoteRunRegistryService`(与 `RemoteRunInboundService`/`RemoteRunControlService` 同列;无需 export,仅供同 module 注入)。

- [ ] **Step 7: 补 inbound spec 的 bind/unbind 断言**

在 `remote-run-inbound.service.spec.ts`:构造时传入一个 fake/real `RemoteRunRegistryService`,断言 `onAgentRunRequest` 后 `sessionIdOf(streamId) === sessionId`;终止事件(run.done)后 `sessionIdOf(streamId)` 为 undefined。

- [ ] **Step 8: 跑相关测试**

Run: `pnpm exec jest apps/server-agent/src/services/remote-run-inbound.service.spec.ts apps/server-agent/src/services/remote-run-registry.service.spec.ts`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add apps/server-agent/src/services/remote-run-registry.service.ts apps/server-agent/src/services/remote-run-registry.service.spec.ts apps/server-agent/src/services/remote-run-inbound.service.ts apps/server-agent/src/services/remote-run-inbound.service.spec.ts apps/server-agent/src/session.module.ts
git commit -m "feat(server-agent): B 侧 streamId→sessionId 注册表(远程 HITL M3 校验真源)"
```

---

### Task 3: B 侧 RemoteRunControlService confirm/answer 真 resolve + M3 校验

**Files:**
- Modify: `apps/server-agent/src/services/remote-run-control.service.ts`
- Test: `apps/server-agent/src/services/remote-run-control.service.spec.ts`

**Interfaces:**
- Consumes: `ConfirmationService.key/resolve`(@Global 可注入)、`RemoteRunRegistryService.sessionIdOf`(Task 2)、`AgentRunControlForwarded`(Task 1,`answers: AnswerItem[]`)。
- Produces: `onAgentRunControl` 处理 confirm/answer(此前 no-op)。

- [ ] **Step 1: 写失败测试**

在 `remote-run-control.service.spec.ts` 追加(沿用现有 fake account.run + runner mock,新增 confirmation + registry mock):

```ts
// confirmation: { key: ConfirmationService.key, resolve: jest.fn(() => true) }
// registry: { sessionIdOf: jest.fn(() => "sess-1") }

it("confirm → 用正确 key resolve,decision 映射到 action", () => {
  service.onAgentRunControl({
    cloudUserId: "u1",
    forwarded: { streamId: "st1", targetDeviceId: "d", sessionId: "sess-1",
      requesterDeviceId: "dA", kind: "confirm", toolCallId: "tc1",
      decision: "send", content: "改写" },
  } as any);
  expect(confirmation.resolve).toHaveBeenCalledWith(
    "u1:sess-1:tc1", { action: "send", content: "改写" });
});

it("answer → resolve 携带结构化 answers", () => {
  const answers = [{ selected: ["A"], other: "o" }];
  service.onAgentRunControl({ cloudUserId: "u1",
    forwarded: { streamId: "st1", targetDeviceId: "d", sessionId: "sess-1",
      requesterDeviceId: "dA", kind: "answer", toolCallId: "tc1", answers } } as any);
  expect(confirmation.resolve).toHaveBeenCalledWith("u1:sess-1:tc1", { answers });
});

it("M3:registry 的 sessionId 与 control.sessionId 不符 → 不 resolve", () => {
  registry.sessionIdOf.mockReturnValue("OTHER-sess");
  service.onAgentRunControl({ cloudUserId: "u1",
    forwarded: { streamId: "st1", targetDeviceId: "d", sessionId: "sess-1",
      requesterDeviceId: "dA", kind: "confirm", toolCallId: "tc1", decision: "send" } } as any);
  expect(confirmation.resolve).not.toHaveBeenCalled();
});

it("confirm 缺 toolCallId → 不 resolve、不抛", () => {
  expect(() => service.onAgentRunControl({ cloudUserId: "u1",
    forwarded: { streamId: "st1", targetDeviceId: "d", sessionId: "sess-1",
      requesterDeviceId: "dA", kind: "confirm", decision: "send" } } as any)).not.toThrow();
  expect(confirmation.resolve).not.toHaveBeenCalled();
});

it("interrupt 回归:仍调 runner.interrupt", () => {
  service.onAgentRunControl({ cloudUserId: "u1",
    forwarded: { streamId: "st1", targetDeviceId: "d", sessionId: "sess-1",
      requesterDeviceId: "dA", kind: "interrupt" } } as any);
  expect(runner.interrupt).toHaveBeenCalledWith("sess-1");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec jest apps/server-agent/src/services/remote-run-control.service.spec.ts`
Expected: FAIL(confirm/answer 现为 no-op,resolve 从未被调)

- [ ] **Step 3: 实现 confirm/answer 分派 + M3**

构造注入 `private readonly confirmation: ConfirmationService` + `private readonly registry: RemoteRunRegistryService`。把 `onAgentRunControl` 的 `account.run` 回调改为:

```ts
this.account.run(cloudUserId, () => {
  if (forwarded.kind === "interrupt") {
    this.runner.interrupt(forwarded.sessionId);
    return;
  }
  // confirm/answer 需 toolCallId
  if (!forwarded.toolCallId) {
    this.logger.warn(`远程 ${forwarded.kind} 缺 toolCallId(sessionId=${forwarded.sessionId}),忽略`);
    return;
  }
  // M3:校验该 streamId 确对应该 sessionId 的活跃 run
  const bound = this.registry.sessionIdOf(forwarded.streamId);
  if (bound !== forwarded.sessionId) {
    this.logger.warn(`远程 ${forwarded.kind} sessionId 与 streamId 绑定不符(streamId=${forwarded.streamId}),拒`);
    return;
  }
  const key = ConfirmationService.key(cloudUserId, forwarded.sessionId, forwarded.toolCallId);
  if (forwarded.kind === "confirm") {
    this.confirmation.resolve(key, { action: forwarded.decision, content: forwarded.content });
  } else if (forwarded.kind === "answer") {
    this.confirmation.resolve(key, { answers: forwarded.answers ?? [] });
  }
});
```

> 注:`ConfirmationService` 静态 `key` 直接用类名调用;`resolve` 用注入实例。confirm 的 `decision` 可能为 undefined(schema optional),但 `ConfirmDecision.action` 要求 `"send"|"cancel"`——remote confirm 帧一定带 decision(前端构造),这里透传;若担心可加 `forwarded.decision ?? "cancel"` 兜底(默认取消更安全)。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec jest apps/server-agent/src/services/remote-run-control.service.spec.ts`
Expected: PASS(含既有 interrupt 用例 + 新增 5 例)

- [ ] **Step 5: check:dead 与提交**

Run: `pnpm check:dead --strict`(0)
```bash
git add apps/server-agent/src/services/remote-run-control.service.ts apps/server-agent/src/services/remote-run-control.service.spec.ts
git commit -m "feat(server-agent): B 侧远程 confirm/answer 真 resolve + M3 sessionId 绑定校验"
```

---

### Task 4: A 侧 RemoteRunService 只读查询方法

**Files:**
- Modify: `apps/server-agent/src/cloud/remote-run.service.ts`
- Test: `apps/server-agent/src/cloud/remote-run.service.spec.ts`

**Interfaces:**
- Consumes: 现有 `streams: Map<streamId, StreamEntry{targetDeviceId, sessionId: string|null, timer}>`、`activeSessionRuns: Map<sessionKey, streamId>`、`static sessionKey`。
- Produces:
  - `type RemoteRunView = { streamId: string; sessionId: string | null }`(导出)
  - `findRunByStreamId(streamId: string): RemoteRunView | null`
  - `findRunBySession(targetDeviceId: string, sessionId: string): RemoteRunView | null`

- [ ] **Step 1: 写失败测试**

在 `remote-run.service.spec.ts` 追加(沿用现有构造 fake relay/emitter):

```ts
it("findRunByStreamId:命中返回 {streamId, sessionId}", () => {
  const { streamId } = service.startRun("u1", "dB", "create", null, "hi");
  expect(service.findRunByStreamId(streamId)).toEqual({ streamId, sessionId: null });
});

it("findRunByStreamId:未知返 null", () => {
  expect(service.findRunByStreamId("nope")).toBeNull();
});

it("findRunBySession:create 首帧回填 sessionId 后可按 session 反查 streamId", () => {
  const { streamId } = service.startRun("u1", "dB", "create", null, "hi");
  service.onFrame({ streamId, sessionId: "sess-9", seq: 0, event: "run.started", payload: { sessionId: "sess-9" } } as any);
  expect(service.findRunBySession("dB", "sess-9")).toEqual({ streamId, sessionId: "sess-9" });
});

it("findRunBySession:未知返 null", () => {
  expect(service.findRunBySession("dB", "no-sess")).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec jest apps/server-agent/src/cloud/remote-run.service.spec.ts`
Expected: FAIL(方法不存在)

- [ ] **Step 3: 实现只读查询**

在 `remote-run.service.ts` 加导出类型 + 两个 public 方法:

```ts
/** 远程 run 的只读视图(供 A 前端/controller 反查当前 streamId↔sessionId)。 */
export type RemoteRunView = { streamId: string; sessionId: string | null };
```

```ts
/** 按 streamId 查活跃远程 run;未找到返 null。 */
findRunByStreamId(streamId: string): RemoteRunView | null {
  const entry = this.streams.get(streamId);
  return entry ? { streamId, sessionId: entry.sessionId } : null;
}

/**
 * 按 (targetDeviceId, sessionId) 反查活跃远程 run 的 streamId;未找到返 null。
 * 用于刷新/直接进入正在跑的远程会话时,前端补齐 streamId 以路由 confirm/interrupt。
 */
findRunBySession(targetDeviceId: string, sessionId: string): RemoteRunView | null {
  const streamId = this.activeSessionRuns.get(RemoteRunService.sessionKey(targetDeviceId, sessionId));
  if (!streamId) return null;
  const entry = this.streams.get(streamId);
  return entry ? { streamId, sessionId: entry.sessionId } : null;
}
```

> 注:`activeSessionRuns` 的槽在 `onFrame` 首帧回填 sessionId 时才占(create 首帧前查不到,符合预期——此时前端还没 sessionId 也不会来查)。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec jest apps/server-agent/src/cloud/remote-run.service.spec.ts`
Expected: PASS

- [ ] **Step 5: check:dead 与提交**

> `findRun*` 会被 Task 5 controller 消费,若本 Task 单独提交时 check:dead --strict 报未消费,加 `@public-api` 注释或与 Task 5 合并提交。建议本 Task 与 Task 5 相邻,提交后紧接 Task 5。

Run: `pnpm check:dead --strict`
```bash
git add apps/server-agent/src/cloud/remote-run.service.ts apps/server-agent/src/cloud/remote-run.service.spec.ts
git commit -m "feat(server-agent): A 侧 RemoteRunService 只读查询(findRunByStreamId/BySession)"
```

---

### Task 5: A 侧 controller 控制出口 + 本机真源端点 + DTO

**Files:**
- Modify: `apps/server-agent/src/dto/remote-run.dto.ts`(新增 confirm/answer/query DTO)
- Modify: `apps/server-agent/src/controllers/remote-device.controller.ts`(3 端点)
- Test: `apps/server-agent/src/controllers/remote-device.controller.spec.ts`(若无则新建)

**Interfaces:**
- Consumes: `RemoteRunService.sendControl`、`findRunByStreamId`、`findRunBySession`(Task 4);`AgentRunAnswerItemSchema`(Task 1)。
- Produces:
  - `POST /api/remote-devices/:id/run/confirm`
  - `POST /api/remote-devices/:id/run/answer`
  - `GET /api/remote-devices/:id/runs?streamId=|sessionId=`

- [ ] **Step 1: 写失败测试**

`remote-device.controller.spec.ts`(mock `RemoteRunService`,断言委托):

```ts
it("run/confirm → sendControl 组 confirm 帧", () => {
  controller.confirm("dB", { streamId: "st1", sessionId: "sess1", toolCallId: "tc1", decision: "send", content: "c" } as any);
  expect(remoteRun.sendControl).toHaveBeenCalledWith("u1", {
    streamId: "st1", targetDeviceId: "dB", sessionId: "sess1",
    kind: "confirm", toolCallId: "tc1", decision: "send", content: "c",
  });
});

it("run/answer → sendControl 组 answer 帧", () => {
  const answers = [{ selected: ["A"], other: "o" }];
  controller.answer("dB", { streamId: "st1", sessionId: "sess1", toolCallId: "tc1", answers } as any);
  expect(remoteRun.sendControl).toHaveBeenCalledWith("u1", {
    streamId: "st1", targetDeviceId: "dB", sessionId: "sess1",
    kind: "answer", toolCallId: "tc1", answers,
  });
});

it("GET runs?streamId → findRunByStreamId", () => {
  remoteRun.findRunByStreamId.mockReturnValue({ streamId: "st1", sessionId: "sess1" });
  expect(controller.runs("dB", { streamId: "st1" } as any)).toEqual({ streamId: "st1", sessionId: "sess1" });
});

it("GET runs?sessionId → findRunBySession", () => {
  remoteRun.findRunBySession.mockReturnValue({ streamId: "st1", sessionId: "sess1" });
  expect(controller.runs("dB", { sessionId: "sess1" } as any)).toEqual({ streamId: "st1", sessionId: "sess1" });
});
```

（controller 构造时 `account.getOrThrow` mock 返 "u1"。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec jest apps/server-agent/src/controllers/remote-device.controller.spec.ts`
Expected: FAIL(方法不存在)

- [ ] **Step 3: 加 DTO**

`remote-run.dto.ts`,按现有 `createI18nZodDto` + 声明合并风格追加:

```ts
export const RemoteConfirmSchema = z.object({
  streamId: z.string().min(1),
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
  decision: z.enum(["send", "cancel"]),
  content: z.string().optional(),
});
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: DTO 声明合并
export class RemoteConfirmDto extends createI18nZodDto(RemoteConfirmSchema) {}
export interface RemoteConfirmDto extends z.infer<typeof RemoteConfirmSchema> {}

export const RemoteAnswerItemSchema = z.object({
  selected: z.array(z.string()),
  other: z.string().optional(),
});
export const RemoteAnswerSchema = z.object({
  streamId: z.string().min(1),
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
  answers: z.array(RemoteAnswerItemSchema),
});
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: DTO 声明合并
export class RemoteAnswerDto extends createI18nZodDto(RemoteAnswerSchema) {}
export interface RemoteAnswerDto extends z.infer<typeof RemoteAnswerSchema> {}

export const RemoteRunsQuerySchema = z.object({
  streamId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
}).refine((v) => !!v.streamId || !!v.sessionId, { message: "streamId 或 sessionId 至少其一" });
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: DTO 声明合并
export class RemoteRunsQueryDto extends createI18nZodDto(RemoteRunsQuerySchema) {}
export interface RemoteRunsQueryDto extends z.infer<typeof RemoteRunsQuerySchema> {}
```

- [ ] **Step 4: 加 controller 端点**

`remote-device.controller.ts`(带 swagger 注解,cloudUserId 用 `this.account.getOrThrow()`):

```ts
/** 远程会话:提交工具确认(im_send / drive_share / drive_create_share)。 */
@Post("remote-devices/:id/run/confirm")
@ApiOperation({ summary: "远程工具确认" })
confirm(@Param("id") id: string, @Body() dto: RemoteConfirmDto): { ok: true } {
  this.remoteRun.sendControl(this.account.getOrThrow(), {
    streamId: dto.streamId, targetDeviceId: id, sessionId: dto.sessionId,
    kind: "confirm", toolCallId: dto.toolCallId, decision: dto.decision, content: dto.content,
  });
  return { ok: true };
}

/** 远程会话:提交 ask_question 回答。 */
@Post("remote-devices/:id/run/answer")
@ApiOperation({ summary: "远程提问回答" })
answer(@Param("id") id: string, @Body() dto: RemoteAnswerDto): { ok: true } {
  this.remoteRun.sendControl(this.account.getOrThrow(), {
    streamId: dto.streamId, targetDeviceId: id, sessionId: dto.sessionId,
    kind: "answer", toolCallId: dto.toolCallId, answers: dto.answers,
  });
  return { ok: true };
}

/** 查本机记录的某远程设备当前活跃 run(按 streamId 或 sessionId 反查),供 create/刷新补齐配对。 */
@Get("remote-devices/:id/runs")
@ApiOperation({ summary: "查活跃远程 run 的 streamId↔sessionId" })
runs(@Param("id") id: string, @Query() query: RemoteRunsQueryDto): RemoteRunView | null {
  if (query.streamId) return this.remoteRun.findRunByStreamId(query.streamId);
  return this.remoteRun.findRunBySession(id, query.sessionId!);
}
```

补 import:`Get`/`Query`/`Post`/`Body`/`Param`(部分已在)、`ApiOperation`、DTO 类、`RemoteRunView`。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm exec jest apps/server-agent/src/controllers/remote-device.controller.spec.ts`
Expected: PASS

- [ ] **Step 6: 全量围栏 + 提交**

Run: `pnpm check:dead --strict` + `pnpm check`(swagger/tx/repo 等)
```bash
git add apps/server-agent/src/dto/remote-run.dto.ts apps/server-agent/src/controllers/remote-device.controller.ts apps/server-agent/src/controllers/remote-device.controller.spec.ts
git commit -m "feat(server-agent): A 侧远程 confirm/answer 端点 + GET runs 本机真源"
```

---

### Task 6: 前端 rest + RemoteSessionContext + hook 暴露/reclaim

**Files:**
- Modify: `apps/web-agent/src/rest/remote-devices.ts`(confirmRemote/answerRemote/fetchRemoteRun)
- Create: `apps/web-agent/src/hooks/remote-session-context.tsx`(RemoteSessionContext + Provider + useRemoteSession)
- Modify: `apps/web-agent/src/hooks/use-session-stream.ts`(暴露 remoteDeviceId + streamId getter;挂载 reclaim)
- Modify: `apps/web-agent/src/components/session/assistant-conversation-body.tsx`(包 Provider)

**Interfaces:**
- Consumes: A 端点(Task 5)。
- Produces:
  - rest:`confirmRemote(deviceId, { streamId, sessionId, toolCallId, decision, content? }): Promise<{ok:true}>`;`answerRemote(deviceId, { streamId, sessionId, toolCallId, answers }): Promise<{ok:true}>`;`fetchRemoteRun(deviceId, q: {streamId?, sessionId?}): Promise<{streamId:string, sessionId:string|null}|null>`
  - `useRemoteSession(): { remoteDeviceId: string; confirm(toolCallId, decision, content?): Promise<void>; answer(toolCallId, answers): Promise<void> } | null`(本地会话下返回 null)
  - `useSessionStream` 返回值新增 `remoteDeviceId: string | null` 和 `getStreamId(): string | null`

- [ ] **Step 1: 加 rest 函数**

`remote-devices.ts`(照现有风格:首参 deviceId,无 try/catch,`const {data}=await apiClient...; return data`):

```ts
export async function confirmRemote(
  deviceId: string,
  body: { streamId: string; sessionId: string; toolCallId: string; decision: "send" | "cancel"; content?: string },
): Promise<{ ok: true }> {
  const { data } = await apiClient.post<{ ok: true }>(`/api/remote-devices/${deviceId}/run/confirm`, body);
  return data;
}

export async function answerRemote(
  deviceId: string,
  body: { streamId: string; sessionId: string; toolCallId: string; answers: { selected: string[]; other?: string }[] },
): Promise<{ ok: true }> {
  const { data } = await apiClient.post<{ ok: true }>(`/api/remote-devices/${deviceId}/run/answer`, body);
  return data;
}

export async function fetchRemoteRun(
  deviceId: string,
  q: { streamId?: string; sessionId?: string },
): Promise<{ streamId: string; sessionId: string | null } | null> {
  const params = new URLSearchParams();
  if (q.streamId) params.set("streamId", q.streamId);
  if (q.sessionId) params.set("sessionId", q.sessionId);
  const { data } = await apiClient.get<{ streamId: string; sessionId: string | null } | null>(
    `/api/remote-devices/${deviceId}/runs?${params.toString()}`,
  );
  return data;
}
```

- [ ] **Step 2: useSessionStream 暴露 remoteDeviceId + getStreamId + reclaim**

`use-session-stream.ts`:
- 返回值(`SessionStream` 类型 + return 对象)新增 `remoteDeviceId: remoteDeviceId ?? null` 和 `getStreamId: () => remoteStreamIdRef.current`。
- 挂载 remote 分支(约 319 行,`if (remoteDeviceId) { fetchRemoteHistory... }`)里加 reclaim:若 `remoteStreamIdRef.current == null`,`fetchRemoteRun(remoteDeviceId, { sessionId }).then((run) => { if (run) remoteStreamIdRef.current = run.streamId; })`(catch 吞掉,失败仅使 confirm/interrupt 不可用,不影响渲染)。

- [ ] **Step 3: 建 RemoteSessionContext**

`remote-session-context.tsx`:

```tsx
"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { confirmRemote, answerRemote } from "@/rest/remote-devices";

type RemoteSession = {
  remoteDeviceId: string;
  confirm: (toolCallId: string, decision: "send" | "cancel", content?: string) => Promise<void>;
  answer: (toolCallId: string, answers: { selected: string[]; other?: string }[]) => Promise<void>;
};

const Ctx = createContext<RemoteSession | null>(null);

/** 远程会话上下文:让深层的 HITL 卡片拿到 remoteDeviceId 与「点击时的实时 streamId」,走远程控制端点。本地会话不包此 Provider,useRemoteSession 返回 null。 */
export function RemoteSessionProvider(props: {
  remoteDeviceId: string;
  sessionId: string;
  getStreamId: () => string | null;
  children: ReactNode;
}): JSX.Element {
  const { remoteDeviceId, sessionId, getStreamId, children } = props;
  const value = useMemo<RemoteSession>(() => ({
    remoteDeviceId,
    confirm: async (toolCallId, decision, content) => {
      const streamId = getStreamId();
      if (!streamId) return;
      await confirmRemote(remoteDeviceId, { streamId, sessionId, toolCallId, decision, content });
    },
    answer: async (toolCallId, answers) => {
      const streamId = getStreamId();
      if (!streamId) return;
      await answerRemote(remoteDeviceId, { streamId, sessionId, toolCallId, answers });
    },
  }), [remoteDeviceId, sessionId, getStreamId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 卡片消费:远程会话返回控制器,本地会话返回 null。 */
export function useRemoteSession(): RemoteSession | null {
  return useContext(Ctx);
}
```

- [ ] **Step 4: 在 conversation body 包 Provider**

`assistant-conversation-body.tsx`:`remoteDeviceId` 非空时,用 `<RemoteSessionProvider remoteDeviceId={remoteDeviceId} sessionId={sessionId} getStreamId={stream.getStreamId}>` 包住渲染 `MessageList` 的子树(本地会话不包,直接渲染)。`stream.getStreamId` 来自 Step 2。

- [ ] **Step 5: typecheck / build**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build`
Expected: 0 error

- [ ] **Step 6: 提交**

```bash
git add apps/web-agent/src/rest/remote-devices.ts apps/web-agent/src/hooks/remote-session-context.tsx apps/web-agent/src/hooks/use-session-stream.ts apps/web-agent/src/components/session/assistant-conversation-body.tsx
git commit -m "feat(web-agent): 远程会话 context + rest(confirm/answer/fetchRemoteRun) + streamId reclaim"
```

---

### Task 7: 前端 4 张卡 remote 分支 + create 改查本机

**Files:**
- Modify: `apps/web-agent/src/components/session/im-send-confirm-card.tsx`
- Modify: `apps/web-agent/src/components/session/ask-question-card.tsx`
- Modify: `apps/web-agent/src/components/session/drive-share-card.tsx`
- Modify: `apps/web-agent/src/components/session/drive-create-share-card.tsx`
- Modify: `apps/web-agent/src/components/home/launcher-home.tsx`
- Modify: `apps/web-agent/src/rest/remote-devices.ts`(移除 `waitForNewRemoteSession`)

**Interfaces:**
- Consumes: `useRemoteSession`(Task 6)、`fetchRemoteRun`(Task 6)。

- [ ] **Step 1: 4 张卡加 remote 分支**

每张卡顶部 `const remote = useRemoteSession();`,把提交处改为分支:
- im-send `act(decision)`:`remote ? await remote.confirm(tool.toolCallId, decision, text) : await confirmSend(sessionId, tool.toolCallId, decision, text);`
- drive-share / drive-create-share `act(decision)`:`remote ? await remote.confirm(tool.toolCallId, decision) : await confirmSend(sessionId, tool.toolCallId, decision);`
- ask-question `submit()`:`remote ? await remote.answer(tool.toolCallId, answers) : await confirmAnswers(sessionId, tool.toolCallId, answers);`

（`sessionId` prop 保留给本地分支用。）

- [ ] **Step 2: create 改造(launcher-home)**

`launcher-home.tsx` 的 `sendToRemoteDevice`:删除 `fetchRemoteSessions` 拍基线 + `waitForNewRemoteSession` 轮询,改为:

```ts
const { streamId } = await startRemoteRun(deviceId, { mode: "create", content });
// 轮询 A 本机(近乎即时:B 首帧一到 onFrame 即回填 sessionId)
let sessionId: string | null = null;
for (let i = 0; i < 40 && !sessionId; i++) {
  const run = await fetchRemoteRun(deviceId, { streamId });
  sessionId = run?.sessionId ?? null;
  if (!sessionId) await new Promise((r) => setTimeout(r, 250));
}
if (!sessionId) { /* 失败提示,复用原有错误处理 */ return; }
router.push(`/assistant?remoteDevice=${deviceId}&id=${sessionId}&streamId=${streamId}`);
```

- [ ] **Step 3: 移除 waitForNewRemoteSession**

从 `remote-devices.ts` 删除 `waitForNewRemoteSession`(及其只被 launcher-home 引用的 import)。全仓 grep 确认无其它引用。

- [ ] **Step 4: typecheck / build / dead**

Run: `pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build && pnpm check:dead --strict`
Expected: 0 error;`waitForNewRemoteSession` 移除后无死引用。

- [ ] **Step 5: 提交**

```bash
git add apps/web-agent/src/components/session/*.tsx apps/web-agent/src/components/home/launcher-home.tsx apps/web-agent/src/rest/remote-devices.ts
git commit -m "feat(web-agent): 4 张 HITL 卡走远程控制 + create 改查本机真源(去轮询 B)"
```

---

## 收尾(全部 Task 后)

- [ ] 全量 `pnpm test`——对比基线(main 上 ~1269 passed + 1 skip)确认无回归 + 新增 B/A 侧单测。
- [ ] `pnpm check`(9 围栏)+ `pnpm check:dead --strict` + `pnpm --filter @meshbot/web-agent typecheck/build`。
- [ ] 双设备手工验证(dev + `run:local`):点确认(send)/拒绝(cancel)/im_send 改文案/ask_question 多问题(selected+other)/drive 分享确认/超时后卡片翻终态/刷新后再 confirm(reclaim)/B 离线后卡片禁用。
- [ ] REQUIRED SUB-SKILL:superpowers:finishing-a-development-branch(push → PR → CI → 合,合并须用户明确授权)。

## Self-Review 备注(写 plan 时已核)

- **Spec 覆盖**:①answers 升级=Task1;②B resolve+M3=Task2/3;③A 端点+真源=Task4/5;④前端卡片+create/reclaim=Task6/7;⑤错误处理(幂等/终态禁用)贯穿 Task3(幂等)+Task7(禁用)。全覆盖。
- **类型一致**:`AnswerItem`/`{selected, other?}` 在 Task1(线路镜像)、Task3(resolve)、Task5(DTO)、Task6(rest/context)、Task7(卡片)全程同形状。`RemoteRunView{streamId, sessionId:string|null}` 在 Task4 产出、Task5/6 消费一致。
- **坑对应**:坑#1(卡片拿不到 remoteDeviceId/streamId)→ Task6 RemoteSessionContext;坑#3/#4(answers 形状+跨域)→ Task1 镜像定义;坑#5(无注册表)→ Task2;坑#6(无只读查询)→ Task4;坑#9(刷新丢 streamId)→ Task6 reclaim + Task4 findRunBySession。
- **零改确认**:Task 全程不碰 runner/graph/工具实现;B 侧仅新增 registry + control resolve 分支。
