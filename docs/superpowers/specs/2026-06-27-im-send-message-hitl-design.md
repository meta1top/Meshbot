# 助手发送 IM 回复（im_send_message + 发送前 HITL 确认）设计

> 状态：已通过 brainstorm，待评审 → writing-plans
> 日期：2026-06-27
> 关联：[[2026-06-27-agent-ui-context-awareness-design]]（只读 IM 工具 + IM_CONTEXT_PORT）、[[2026-06-20-socket-architecture-design]]（ws/session + ImRelayClientService）、[[2026-06-17-phase3-im-companion-agent-design]]（companion）

## 1. 目标

让助手能替用户把回复**发到指定频道/私聊**——但每次发出前，必须由用户在 UI 上对**可编辑的内容预览**点「发送」确认。发送在服务端工具内完成（agent 拿到真实结果可续答），真正发出由人点击把关（外部、不可撤回动作的安全门）。

承接 [[2026-06-27-agent-ui-context-awareness-design]]：助手已能感知当前会话 + 读消息（只读 IM 工具），本期补上**写侧**的「发送」闭环。

## 2. 非目标（YAGNI）

- **不做** companion（`kind='im'` 自动应答 agent）自动发帖——其回复仍只草稿/本地存档，不自动发到频道（更高风险，单独议题）。
- **不做** 持久化确认队列：确认态是内存 deferred；进程重启中途丢失 → 该 run 终止，用户重问即可。
- **不用** LangGraph 原生 interrupt（要改 checkpointer/resume 语义，过重）——用**应用层挂起**（工具 `execute` await 一个 deferred）。
- **不加** 新 ws 事件：确认卡直接由既有 tool-call 流（`im_send_message` 的 tool_call 名 + args）驱动渲染。

## 3. 流程（Approach 2：应用层挂起 HITL）

```
用户：「帮我回复 Test06」
 → agent 拟稿 → 调 im_send_message({conversationId, content})
 → 工具 execute 不立即发，调端口 confirmAndSend(...) 进入【挂起 await】
 → 前端把这次 im_send_message 的 tool-call 渲染成【可编辑确认卡】(预填 content + 目标名 + [发送][取消])
 → 用户(可改文本后)点[发送] → POST /api/sessions/:id/confirm {toolCallId, decision:"send", content:<编辑后>}
 → ConfirmationService 解掉 deferred → 工具经 ImRelayClientService.send 真正发出 → execute 返回 {status:"sent",...}
 → supervisor 续跑 → agent 回「已帮你发出 ✅」
   点[取消] → decision:"cancel" → 工具返回 {status:"cancelled"} → agent 回「好的，没发」
```

确认请求**不需要新事件**：`im_send_message` 的 tool_call_start + args（含 conversationId/content）已流到前端；前端据 tool 名特判渲染确认卡。工具处于 in-progress（未 end）即「待确认」；end 即终态。

## 4. 工具：`im_send_message`（libs/agent，写侧）

- 参数 schema（libs/types-agent）：`{ conversationId: string(min1), content: string(min1) }`。
- execute：调端口 `IM_SEND_PORT.confirmAndSend({ sessionId: ctx.sessionId, toolCallId: ctx.toolCallId, conversationId, content }, ctx.signal)`，把返回的结果 JSON 字符串原样返回给 agent（ToolMessage 内容）。
- 工具本身**不碰 relay/UI/ConfirmationService**（守 libs/agent 边界）。
- description 明确语义：「发送一条消息到某会话；**发出前会展示给用户确认**，仅在用户明确要求发送/回复时调用」。
- 注册进 AgentModule providers。

## 5. 端口：`IM_SEND_PORT`（libs/agent 定义，server-agent 绑定）

新建独立端口（与只读 `IM_CONTEXT_PORT` 分开：读 vs 写+HITL 语义不同）：

```ts
export const IM_SEND_PORT = Symbol("IM_SEND_PORT");
export interface ImSendPort {
  /**
   * 请求用户确认并（确认后）发送。返回结果 JSON 字符串：
   * {"status":"sent"|"cancelled"|"timeout"|"interrupted"|"error", ...}
   */
  confirmAndSend(
    params: { sessionId: string; toolCallId: string; conversationId: string; content: string },
    signal: AbortSignal,
  ): Promise<string>;
}
```

server-agent 实现（编排）：
1. 在 `ConfirmationService` 按 key `${sessionId}:${toolCallId}` 注册 deferred，`await` 它，**race** `signal`（Stop）+ 超时（`IM_SEND_CONFIRM_TIMEOUT_MS = 120_000`）。
2. 解出 `{action, content?}`：
   - `send` → 取**编辑后内容** `content ?? 原 content`，调 `ImRelayClientService.send(account.getOrThrow(), { conversationId, content: final })` → 返回 `{"status":"sent","content":final}`。
   - `cancel` → `{"status":"cancelled"}`。
3. 超时 → `{"status":"timeout"}`；signal abort → `{"status":"interrupted"}`；relay `IM_NOT_CONNECTED` 等异常 → `{"status":"error","reason":...}`（不抛，让 agent 如实告知）。
4. finally：从 ConfirmationService 清理该 key。

## 6. `ConfirmationService`（server-agent，新）

内存态确认管理（单用户本地轨，足够）：
- `register(key): Promise<Decision>` —— 建 deferred 存入 `Map<string, {resolve}>`，返回该 promise。
- `resolve(key, decision: Decision)` —— 解掉对应 deferred；key 不存在则 no-op（幂等，防重复点击/迟到确认）。
- `Decision = { action: "send" | "cancel"; content?: string }`。
- 超时/abort 的竞速在端口实现里用 `Promise.race`；ConfirmationService 只管注册/解决。
- 注：超时/abort 后要 `resolve`-不了的 deferred 由端口 finally 清 key，避免泄漏。

## 7. 确认回传端点（server-agent）

`POST /api/sessions/:id/confirm`，体 `{ toolCallId: string, decision: "send"|"cancel", content?: string }`：
- JWT 鉴权；校验 `:id` 会话属于当前账号（复用既有会话归属校验）。
- 调 `ConfirmationService.resolve("${id}:${toolCallId}", { action: decision, content })`。
- 返回 `{ ok: true }`（幂等：key 不存在也返回 ok，防用户重复点击/已超时）。
- Controller 瘦：逻辑下沉到持有 ConfirmationService 的 Service。

## 8. 实际发送（复用既有）

`ImRelayClientService.send(cloudUserId, { conversationId, content })` —— **已存在**，登录即连（不依赖浏览器在线），是前端手动发消息的同一上行路径。本期不新增发送通道、不加 REST 发送端点。

## 9. 前端确认卡（web-agent，可编辑）

- 在助手会话消息流的 tool-call 渲染处，对工具名 `im_send_message` 特判：
  - **in-progress（待确认）**：渲染可编辑卡——预填 `args.content` 的 textarea + 目标会话名（用 `conversationsAtom` 把 `args.conversationId` 解析成名/对端）+ [发送]/[取消]。
  - 点[发送]：`POST /api/sessions/:id/confirm {toolCallId, decision:"send", content:<textarea 当前值>}`；点[取消]：`decision:"cancel"`。
  - **ended（终态）**：据工具结果 `{status}` 显示「已发送 ✅ / 已取消 / 超时」，随后 agent 收尾消息正常流式出现。
- 复用既有 ws/session 流与消息渲染；新增仅这一种 tool-call 的卡片化渲染 + 一个 confirm 调用。

## 10. 边界与不变量

- **作用域**：仅「用户→助手」会话用（dock/助手会话）；companion 不自动发。工具注册在 AgentModule（全会话可见），但只有用户明确要求才调。
- **账号作用域**：relay send 用 `account.getOrThrow()`（工具在账号上下文内执行）；confirm 端点校验会话归属，用户只能确认自己会话的发送。
- **libs/agent 边界**：工具只依赖 `IM_SEND_PORT`（返回 string）；relay/ConfirmationService/HTTP 全在 server-agent。
- **安全**：发出永远经用户点击；超时/中断默认**不发**（fail-safe）。

## 11. 测试

- **后端**：
  - `ConfirmationService`：register/resolve、重复 resolve 幂等、未知 key no-op。
  - `IM_SEND_PORT.confirmAndSend` 实现：confirm→send（断言调 relay.send 且用编辑后 content）、cancel、超时（假定时器）、abort（signal）、relay 抛错→error 分支。
  - confirm 端点：account 归属校验、resolve 透传、幂等 ok。
  - 工具透传单测（mock 端口）。
- **前端**：确认卡 pending/sent/cancelled 渲染 + 点击触发 confirm（含编辑后 content）。
- **集成**：DI boot 验证（新 ConfirmationService/IM_SEND_PORT 绑定）；端到端冒烟（dock 让助手发给某 DM，改字后点发送，确认对端收到）。

## 12. 涉及文件（预估）

- libs/types-agent：`im_send_message` 入参 schema（追加到 im-tools.ts 或新文件）。
- libs/agent：`tools/im-send.port.ts`（IM_SEND_PORT）、`tools/builtins/im-send-message.tool.ts`、agent.module 注册、index 导出。
- server-agent：`services/confirmation.service.ts`、`IM_SEND_PORT` 绑定模块/provider（编排 confirmAndSend，注入 ConfirmationService + ImRelayClientService + AccountContextService）、`POST /api/sessions/:id/confirm` controller + service 方法。
- web-agent：tool-call 渲染特判 `im_send_message` → 可编辑确认卡组件 + confirm REST 封装。
