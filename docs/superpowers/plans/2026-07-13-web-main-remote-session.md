# web-main 二期远程会话 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** server-main L3 发起方泛化（浏览器可发起）+ 会话 UI 全量抽包（SessionTransport）+ web-main `/assistant/[deviceId]` 完整远程会话。

**Architecture:** 三阶段推进：①协议泛化（路由表判别联合 + user socket 精确回流，B 端零改动）；②抽包（先接口与 web-agent 适配器就位 → hook 原位 transport 化保持全绿 → hook 与 15 组件分批迁 web-common）；③web-main remote-only transport（ws/im 用户 socket 解 AgentRunFrame）+ 页面装配。web-main 会话形态 ≡ web-agent 远程会话形态，不发明新语义。

**Tech Stack:** NestJS socket.io gateway + Next.js + jotai（留 app 层）+ web-common props/labels 模式（一期已验证）

## Global Constraints

- 分支 `feat/web-main-remote-session`，连续提交；中文 conventional commits。
- **web-agent 会话全功能零回归一票否决**（本地+远程双形态：流式/思考/工具/HITL/todo/用量/产物/重生成/反馈）；每个触碰 web-agent 会话链路的 Task 结束跑全量 jest + 两端 typecheck。
- **B 端 server-agent 零改动**；L3 安全不变量逐条保留（帧回流校验发送方=登记 targetDeviceId；控制帧校验发送方=登记 requester kind+id 全等；同账号校验；越权静默拒）。
- `packages/web-common` 禁 jotai/next-intl/app 路径/apiClient；组件 props+labels 注入。
- AgentRunFrame 帧格式不改；`requesterDeviceId` 字段语义兼容（user 发起填 `"user:<socketId>"`，B 端原样回填不解析）。
- 接口契约修改必须在报告声明并同步到后续 Task 的消费预期（一期 T6 先例）。
- 每 Task：相关 typecheck + 测试 + 独立 commit。

---

### Task 1: 协议泛化——路由表与三个入口（TDD）

**Files:**
- Modify: `apps/server-main/src/ws/im.gateway.ts`（agentRunRoutes 类型 :83-85、handleAgentRunStart :379-、handleAgentRunFrame/End、handleAgentRunControl :465-、handleDeviceQueryRequest :329-、断连清理 :225-）
- Modify: `libs/types/src/im/im.schema.ts`（无 schema 变更预期；仅确认 requesterDeviceId 注释补充 user 形态说明）
- Test: `apps/server-main/src/ws/im.gateway.spec.ts`（现有 spec 扩展；若无则新建，mock server/sockets）

**Interfaces:**
- Produces（后续 Task 依赖的协议行为）：
  - 用户连接（`client.data.user` 无 deviceId）可发 `agentRunStart/agentRunControl/deviceQueryRequest`；
  - 路由表：`Map<string, { requester: { kind: "device"; deviceId: string } | { kind: "user"; socketId: string }; targetDeviceId: string }>`；
  - 回流：device → `to(\`device:${deviceId}\`)`；user → `this.server.sockets.sockets.get(socketId)?.emit(...)`；
  - 转发帧的 `requesterDeviceId` 字段：device 发起填 deviceId，user 发起填 `"user:" + socketId`（B 端原样回填）；
  - deviceQueryResponse 回流：`requesterDeviceId` 以 `"user:"` 前缀开头 → 解析 socketId 直发该 socket，否则按 device room（保持既有）；
  - user socket 断连（handleDisconnect）：清理其为发起方的路由（`kind==="user" && socketId===client.id`）。

- [ ] **Step 1（TDD）**: gateway spec 新增用例（照现有 spec 的 mock 形态；无现有 spec 则用 `{ to: jest.fn().mockReturnValue({ emit }), sockets: { sockets: new Map() } }` 伪 server）：
  1. user 连接发 agentRunStart（target 同账号在线）→ 路由登记 `{kind:"user",socketId}`，target device room 收到 start 且 requesterDeviceId 为 `"user:<sid>"`；
  2. B 回流 agentRunFrame → 按 socketId 直发 user socket（`sockets.get(sid).emit` 被调）；
  3. user 连接发 agentRunControl（streamId 是自己登记的）→ 转发；他人 streamId → 静默拒；
  4. device 发起路径回归：全部按 room 语义不变；
  5. user socket 断连 → 其发起的路由被清理；
  6. user 发 deviceQueryRequest → target 收到 `requesterDeviceId:"user:<sid>"`；response 回流直发该 socket。

跑红后实施。

- [ ] **Step 2**: 实现——`RunRequester` 类型与判别工具函数（gateway 内私有）：

```ts
type RunRequester =
  | { kind: "device"; deviceId: string }
  | { kind: "user"; socketId: string };

/** 从连接推导发起方身份：设备连接用 deviceId（room 稳定），用户连接用 socket.id（断线即毁）。 */
private requesterOf(client: Socket): RunRequester {
  const deviceId = (client.data.user as { deviceId?: string })?.deviceId;
  return deviceId
    ? { kind: "device", deviceId }
    : { kind: "user", socketId: client.id };
}

/** 转发帧 requesterDeviceId 字段编码（B 端原样回填不解析）。 */
private encodeRequester(r: RunRequester): string {
  return r.kind === "device" ? r.deviceId : `user:${r.socketId}`;
}

/** 回流定向：device 走 room；user 直发 socket（不存在则丢弃——发起方已断）。 */
private emitToRequester(r: RunRequester, event: string, payload: unknown): void {
  if (r.kind === "device") {
    this.server.to(`device:${r.deviceId}`).emit(event, payload);
    return;
  }
  this.server.sockets.sockets.get(r.socketId)?.emit(event, payload);
}
```

三个入口去掉 `if (!requesterDeviceId) return` 改用 `requesterOf`；Frame/End/Response 回流处按解码路由（`agentRunRoutes` 查表优先；deviceQueryResponse 无路由表——按 `"user:"` 前缀判别）；控制帧校验 `route.requester` 与 `requesterOf(client)` kind+id 全等；断连清理扩展 user 分支（handleDisconnect 里 `client.id` 匹配）。

- [ ] **Step 3**: 跑绿 + 既有 gateway 相关测试全绿 + `pnpm --filter @meshbot/server-main typecheck`。
- [ ] **Step 4**: Commit `feat(server-main): L3 发起方泛化——浏览器 user socket 可发起远程会话/查询`。

---

### Task 2: server-main e2e（真 WS 双角色）

**Files:**
- Create: `apps/server-main/test/e2e/agent-run-user-origin.e2e.spec.ts`（照 `im-flow.spec.ts` 的建 app/连 WS 模式）

- [ ] **Step 1**: e2e 用例（真 socket.io 客户端两个：用户 JWT 连接 A、伪设备 token 连接 B）：
  1. A（user）emit agentRunStart{targetDeviceId:B} → B 收到 start（requesterDeviceId 前缀 `user:`）；
  2. B emit agentRunFrame{streamId, requesterDeviceId 原样回填} → A 收到帧；
  3. B emit agentRunEnd → A 收到 end；
  4. A emit agentRunControl{streamId} → B 收到；另一用户连接 C 用同 streamId 发 control → B 不应收到（越权拒）；
  5. A 断开重连（新 socket）后 B 再回流帧 → 无人收到且不报错（路由已清理）；
  6. deviceQuery：A emit deviceQueryRequest{kind:"sessions"} → B 收到并回 response → A 收到。
- [ ] **Step 2**: 本地起 Postgres（`pnpm dev:db:up` 或既有实例）实跑全绿；多标签语义（两个 user socket 各自独立 streamId）在用例 5 变体中钉住。
- [ ] **Step 3**: Commit `test(server-main): user 发起方 L3 全链 e2e——双角色真 WS`。

---

### Task 3: SessionTransport 接口 + web-common/session 骨架（TDD）

**Files:**
- Create: `packages/web-common/src/session/transport.ts`
- Create: `packages/web-common/src/session/transport.spec.ts`
- Create: `packages/web-common/src/session/index.ts`
- Modify: `packages/web-common/package.json`（exports 加 `"./session"`）

**Interfaces:**
- Produces（后续 Task 契约；形态修正须报告声明并同步）：

```ts
import type { HistoryResponse, SessionSummary } from "@meshbot/types-agent";

/** run 流事件（本机 session WS 事件与远程 AgentRunFrame 解包后的统一形态）。 */
export interface SessionRunEvents {
  /** event 名即 SESSION_WS_EVENTS 值（run.chunk/run.done/run.usage/...），payload 原样。 */
  onEvent: (event: string, payload: unknown) => void;
}

export interface StartRunInput {
  mode: "create" | "append";
  sessionId?: string;
  content: string;
}

/** 会话数据传输接口：hook 唯一数据入口。web-agent=本机(local+remote)；web-main=remote-only。 */
export interface SessionTransport {
  readonly capabilities: { localRun: boolean };
  listSessions(): Promise<SessionSummary[]>;
  fetchHistory(sessionId: string, opts?: { before?: string; limit?: number }): Promise<HistoryResponse>;
  startRun(input: StartRunInput): Promise<{ streamId: string | null }>;
  interrupt(streamId: string | null, sessionId: string): Promise<void>;
  confirm(streamId: string | null, sessionId: string, toolCallId: string, decision: "send" | "cancel", content?: string): Promise<void>;
  answer(streamId: string | null, sessionId: string, toolCallId: string, answers: { selected: string[]; other?: string }[]): Promise<void>;
  patchSessionModel(sessionId: string, modelConfigId: string): Promise<void>;
  readArtifact(sessionId: string, path: string): Promise<
    | { kind: "content"; name: string; base64: string }
    | { kind: "too-large"; name: string; size: number }
  >;
  uploadArtifactToDrive(sessionId: string, path: string): Promise<{ fileId: string; name: string }>;
  /** 订阅 run 事件流（连接生命周期由适配器管理）；返回退订。 */
  subscribe(events: SessionRunEvents): () => void;
}

/** AgentRunFrame 序号重排缓冲：帧可能乱序到达，按 seq 连续吐出。纯逻辑，TDD。 */
export class FrameSequencer {
  push(frame: { seq: number; event: string; payload: unknown }): Array<{ event: string; payload: unknown }>;
  reset(): void;
}
```

- [ ] **Step 1（TDD）**: `FrameSequencer` 用例先红：顺序帧即吐/乱序缓冲后连续吐/reset 清零/重复 seq 丢弃。
- [ ] **Step 2**: 实现跑绿（web-common jest；root `pnpm test` 已串收集）。夹具形状注意：**先看 @meshbot/types-agent 真类型再写**（前工程教训：spec 文件不做类型检查，人工比对）。
- [ ] **Step 3**: exports 接线 + web-common build + commit `feat(web-common): SessionTransport 契约 + FrameSequencer（会话抽包骨架）`。

---

### Task 4: web-agent 适配器（本机链路包装，hook 未动）

**Files:**
- Create: `apps/web-agent/src/lib/session-transport.ts`
- Test: 纯映射逻辑随 Task 5 的 hook 回归覆盖（本 Task 仅 typecheck + 单元级构造测试若可行）

**Interfaces:**
- Consumes: Task 3 契约；现有 `apps/web-agent/src/rest/session.ts`（fetchHistory/appendMessage/...）、`apps/web-agent/src/rest/remote-devices.ts`（fetchRemote* 全家）、`apps/web-agent/src/lib/socket.ts`（getSessionSocket）。
- Produces: `createLocalSessionTransport(): SessionTransport`（本机会话）与 `createRemoteSessionTransport(deviceId: string): SessionTransport`（A 端远程会话——包 remote-devices REST + 帧回放通道）。两者 web-agent 内部使用；Task 5 的 hook 按会话形态选用。

- [ ] **Step 1**: 实现两个工厂——local：REST+session WS 事件桥 subscribe；remote：fetchRemoteSessions/History/startRemoteRun/confirmRemote/answerRemote/interruptRemoteRun/patchRemoteSessionModel/fetchRemoteArtifact/uploadRemoteArtifactToDrive 一一映射；subscribe 桥现有远程帧回放事件源（use-session-stream 现在怎么收远程帧就桥什么——读 hook :309-340 remote 分支确认事件源后包装，不改变事件流本身）。
- [ ] **Step 2**: typecheck + commit `feat(web-agent): SessionTransport 本机/远程双适配器（hook 接入前置）`。

---

### Task 5: use-session-stream 原位 transport 化（web-agent 全绿硬门）

**Files:**
- Modify: `apps/web-agent/src/hooks/use-session-stream.ts`（1095 行——本 Task 只换数据入口，不迁移文件）
- Modify: 调用方（assistant-conversation-body 等）传入 transport 实例

- [ ] **Step 1**: hook 参数加 `transport: SessionTransport`；内部所有 REST 调用（fetchHistory/appendMessage/startRemoteRun/confirmRemote/...）逐一替换为 transport 方法；jotai atoms 的写入维持现状（本 Task 不动 atoms——hook 还在 app 层）；remote/local 分支判断改由 `transport.capabilities.localRun` 与现有 remoteDeviceId 参数共同驱动（行为等价重构，别改语义）。
- [ ] **Step 2**: 调用方装配：本地会话传 `createLocalSessionTransport()`，远程会话传 `createRemoteSessionTransport(deviceId)`（memo 化）。
- [ ] **Step 3**: **硬门**：全量 jest + 两端 typecheck + `pnpm check`；手工冒烟本地会话（发消息/流式/工具/HITL）与远程会话（双设备）——报告必须记录冒烟结果；行为差异=打回。
- [ ] **Step 4**: Commit `refactor(web-agent): use-session-stream 数据入口 transport 化（行为零变化）`。

---

### Task 6: hook 迁入 web-common

**Files:**
- Create: `packages/web-common/src/session/use-session-stream.ts`（从 web-agent 移动）
- Modify: `apps/web-agent/src/hooks/use-session-stream.ts` → 薄 re-export + atoms 桥（hook 的 atoms 写入点改为回调 props：`onUsage/onTitleUpdated/onSessionsChange`，web-agent 桥回 jotai）
- Test: hook 内纯函数（如时间线归并）若可剥离则剥到 `timeline.ts` + spec

- [ ] **Step 1**: 迁移——hook 文件移入 web-common；jotai import 全部消除（回调化）；`@/` 路径依赖改 props/参数（TimelineMessage 类型一并迁入 web-common/session）；clientSnowflakeId 已在 web-common。
- [ ] **Step 2**: web-agent 薄桥：包一层把回调接回 atoms（usage atomFamily/sessions/todo 派生逻辑不动）。
- [ ] **Step 3**: 硬门同 Task 5（全量回归 + 双形态冒烟记录）。
- [ ] **Step 4**: Commit `refactor(session): use-session-stream 迁入 web-common（atoms 回调化，web-agent 薄桥）`。

---

### Task 7/8/9: 15 会话组件分三批抽包（每批一 Task，一期模式）

批次划分（依赖顺序：叶→卡片→骨干）：
- **T7 叶组件批**：markdown-content / reasoning 折叠（在 message-list 内则随 T9）/ message-skeleton / pending-list / user-message-actions / assistant-message-actions
- **T8 卡片批**：tool-call-block / ask-question-card / im-send-confirm-card / drive-share-card / drive-create-share-card / artifact-file-card / subagent-card / todo 面板
- **T9 骨干批**：message-list / assistant-conversation-body（拆为 web-common `SessionConversationView` + web-agent 装配壳）

每批模式（与一期 IM 抽包完全一致，逐组件执行）：
- [ ] Step A：读源组件全文 → 复制入 `packages/web-common/src/session/` → `useAtomValue/apiClient/rest/useTranslations` 全部改 props + labels（labels key 按源文件实际 t() 调用列全）；类型 @meshbot/types-agent。
- [ ] Step B：web-agent 原文件改薄容器（数据装配→props）。
- [ ] Step C：每组件验证：web-agent typecheck + `npx jest apps/web-agent` + web-common test。
- [ ] Step D：每组件独立 commit `refactor(session): 抽 <组件> 到 web-common（web-agent 原位替换零行为变化）`。
- [ ] 每批收尾：全量 jest + `pnpm check` + 眼验该批功能点；T9 批后完整双形态眼验（一票否决）。

特殊注意：
- artifact-file-card 的预览点击回调化（`onPreview(path)`——web-agent 接 previewArtifactAtom，web-main 接自己的预览面板）；
- HITL 卡的 confirm/answer 走 hook 上下文回调（现 RemoteSessionProvider 模式泛化为 props 传入,或迁 provider 入 web-common——实施取侵入最小者并报告）；
- 用量环/tooltip 的 modelName 解析函数（resolveModelName）已在 web-agent lib——纯函数迁 web-common。

---

### Task 10: web-main remote-only transport

**Files:**
- Create: `apps/web-main/src/lib/session-transport.ts`（`createRemoteSessionTransport(deviceId): SessionTransport`）
- Modify: `apps/web-main/src/lib/im-socket.ts`（复用单例；补 agentRun*/deviceQuery* 事件桥）
- Test: `packages/web-common/src/session/` 内已有 FrameSequencer；transport 的 query 往返/帧解包纯逻辑部分抽小模块就地 spec（一期 presence-cache 先例）

- [ ] **Step 1**: deviceQuery 往返封装（correlationId 生成/超时/响应匹配——web-agent 的 RemoteDeviceQueryService 是服务端版参照，这里是浏览器版：emit deviceQueryRequest + 等 response 事件按 correlationId settle，10s 超时）。
- [ ] **Step 2**: transport 实现：listSessions/fetchHistory/patchSessionModel/readArtifact/uploadArtifactToDrive → query kinds；startRun → emit agentRunStart（streamId 客户端生成 snowflake）；confirm/answer/interrupt → agentRunControl；subscribe → agentRunFrame 经 FrameSequencer 重排后吐 `onEvent(frame.event, frame.payload)`，agentRunEnd → 合成 end 事件；capabilities.localRun=false。
- [ ] **Step 3**: 单测（伪 socket 注入：query 超时/correlationId 错配忽略/帧乱序经 sequencer 归位/end 清理）。
- [ ] **Step 4**: Commit `feat(web-main): 远程会话 transport——用户 socket 直连 L3 帧流`。

---

### Task 11: web-main /assistant/[deviceId] 装配

**Files:**
- Modify: `apps/web-main/src/app/(shell)/assistant/[deviceId]/page.tsx`（占位 → 完整会话）
- Create: `apps/web-main/src/components/assistant/remote-session-view.tsx`（装配 SessionConversationView + hook + transport）
- Create: `apps/web-main/src/components/assistant/session-sublist.tsx`（该设备会话列表：设备子栏内二级列表或替换设备详情侧区——沿用 web-agent 助手区「设备→会话」的侧栏结构）
- Modify: `apps/web-main/messages/{zh,en}.json`（会话 labels 全量注入）
- Modify: `apps/web-main/src/components/artifact 预览接线`（一期 ArtifactBody 已有 remote 分支——数据源换 transport 调用，复用大文件网盘路径）

- [ ] **Step 1**: 会话列表子栏（listSessions + 新建会话入口 + 选中态）；空态/骨架照 loading-states。
- [ ] **Step 2**: RemoteSessionView：use-session-stream(web-common) + transport(deviceId) + 全组件 labels 注入；输入框（ChatInput 等价功能——web-common 已有 MessageInput（IM 版），会话版输入若 T9 未抽 ChatInput 则 web-main 用 web-common 会话输入组件——T9 拆 assistant-conversation-body 时明确输入组件归属并在报告同步）。
- [ ] **Step 3**: 设备离线：发起时 offline 错误提示条；HITL 卡/中断/模型切换/产物预览逐项接线。
- [ ] **Step 4**: i18n + typecheck + build + commit `feat(web-main): 设备远程会话页——完整会话界面上线`。

---

### Task 12: 全量回归 + 终审 + 终验

- [ ] **Step 1**: `pnpm typecheck` / `pnpm test`（root+web-common）/ lib-agent vitest / `pnpm check` / sync:locales 全绿。
- [ ] **Step 2**: `pnpm build:server-main`；桌面 pack（web-agent 会话链路大改，打包 app 必须更新）+ `pnpm rebuild better-sqlite3`。
- [ ] **Step 3**: 整分支终审（最强模型）后交用户终验：
  - [ ] **web-agent 一票否决**：本地会话全功能 + 远程会话全功能（双设备）
  - [ ] web-main → 在线设备：新建会话流式对话 / 思考过程 / 工具卡 / HITL 确认+提问 / 中断 / 续聊历史 / 切模型 / 产物预览（含 >2MB 网盘路径）
  - [ ] 设备离线发起 → 明确报错；会话中设备掉线 → 流终止提示
  - [ ] 多标签页：两个 web-main 标签各自独立会话互不串流
  - [ ] web-main IM（一期功能）无回归

## 回归结论

<!-- 终验通过后填写 -->
