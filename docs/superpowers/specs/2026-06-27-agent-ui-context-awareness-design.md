# Agent 感知前端状态（UI-Context Awareness）设计

> 状态：已通过 brainstorm，待评审 → writing-plans
> 日期：2026-06-27
> 关联：[[2026-06-23-agent-memory-and-runtime-context-design]]（`system:ctx` 注入）、[[2026-06-20-socket-architecture-design]]（ws/events）、[[2026-06-17-phase3-im-companion-agent-design]]（companion 会话）

## 1. 目标

让用户在桌面端（web-agent）**任意页面**问助手时，助手能自动感知「用户此刻在看什么」——当前停留的页面、当前打开的频道/私聊及其未读情况——并能按需拉取更深的内容（某会话的聊天记录、全局未读概览、频道成员），从而给出贴合当前情境的建议。

典型场景：用户在频道「产品研发」里看到同事一条消息，打开助手面板问「帮我看看这个怎么回」，助手能感知到当前在 id=321 这个频道，自动读取最近对话，给出回复建议。

## 2. 非目标（YAGNI）

- **不做** ws/events 持续上报 UI 状态：UI 状态只在用户发消息时随消息携带，已足够覆盖「随处可问」。不引入常驻上报通道与 per-account 临时态存储。
- **不做** 默认注入全局未读概览：全局未读靠工具 `im_unread_overview` 按需拉，不进每轮上下文。
- **不改** IM 数据模型：IM 会话/消息在云端（server-main），server-agent 通过 `CloudImService` 只读代理。
- **本期不做**「助手替用户回复/发消息」（`im_send_message`）：本期工具集为**只读感知**。写入类工具列为后续可选项（见 §10）。
- companion 会话（`kind='im'`，频道里自动应答的 agent）**不注入** `<llmuse>` 块：它没有「用户当前页面」概念，由 IM 消息触发。但只读工具对它同样可用。

## 3. 机制总览（方案 A：隐藏块挂在用户消息上）

1. **前端组装**：用户向助手发消息时，web-agent 从本地 UI 状态（Jotai atoms）渲染一个隐藏的 `<llmuse>…</llmuse>` 块，**前置**到消息 content，一起发送。
2. **进入 LLM 上下文**：该块作为 content 的一部分，照常入队（PendingMessage）、持久化（`session_messages`）、喂给 LangGraph（checkpointer）。模型能看到。
3. **UI 隐藏**：前端渲染助手消息时（实时流 + 历史回填），按约定语法剥离 `<llmuse>` 块，用户看不到。
4. **系统提示说明**：libs/agent 的 system prompt 增加一段，告知模型 `<llmuse>` 块是用户当前界面状态，作上下文用、**不要原样复述**，要更深内容时调 IM 工具。
5. **按需深挖**：助手有一组账号作用域的只读 IM 工具，可拉取某会话聊天记录、全局未读概览、频道成员。

### 决策记录
- **前端组装 + 前端剥离**（而非后端组装）：块的数据源是 UI 状态，前端最清楚；且「隐藏」由前端渲染层负责，组装与隐藏同处一端，对称、简单。块原文存入 `session_messages` 历史，渲染时按语法剥离。
- **每轮绑定**：块挂在每条用户消息上，天然记录「问这句话时在哪个页面」。代价是 checkpointer 历史逐轮累积小块（一行级，且上下文压缩会归纳旧轮），可接受。

## 4. `<llmuse>` 语法与内容

### 语法
- 约定标签：`<llmuse>` … `</llmuse>`。
- 标签常量在共享层定义一处（建议 `libs/types-agent`，无 NestJS/TypeORM 依赖，前后端 + 提示词文档可共享），供前端组装、前端剥离、系统提示三处引用，避免散落字面量。

### 内容（必要且有用，不为简而简）
- 当前页面（人类可读名）。
- 若停留在某会话：会话 id、类型（channel/dm）、名字或对端、该会话未读数。
- 非会话页（日程/技能/设置/助手主页）只放页面行。

示例：
```
<llmuse>
页面: 消息
会话: 频道「产品研发」(channel, id=321), 未读 5
</llmuse>
帮我看一下同事这个事情怎么处理？
```

### 上下文取值约定
- 助手面板叠加在某频道/私聊之上时，`<llmuse>` 取**底层会话**的上下文（`currentConversationIdAtom` 仍指向该会话），而非「助手面板」本身。
- 用户就在助手主页/会话页（无外部会话打开）时，只放页面行，不放会话行。

## 5. 前端改动（apps/web-agent）

| 项 | 说明 |
|----|------|
| `buildLlmuseBlock()` | 纯函数：从 Jotai atoms（`usePathname`/`areaFromPath` 路由 + `currentConversationAtom` + `unreadCount`）拼出结构化块字符串；无会话上下文时只含页面行。 |
| 发送入口接线 | 用户→助手消息的发送路径（assistant 会话 composer + 助手面板 composer）在 content 前拼接该块后再发送。 |
| `stripLlmuse(content)` | 纯函数：剥离 `<llmuse>…</llmuse>` 块（含前导空行），用于助手消息渲染组件（实时流 + 历史回填）统一隐藏。 |
| 边界 | **仅** 用户→助手轮次加块；IM 频道里发给同事的普通消息（`im.send`）不加。 |

`buildLlmuseBlock` / `stripLlmuse` 与标签常量建议放 `packages/web-common` 或 web-agent 内共享工具，与 `libs/types-agent` 的标签常量保持同一字面量来源。

## 6. 后端改动（apps/server-agent + libs/agent）—— 极小

- **消息透传**：块是前端组装的纯文本，照常 PendingMessage 入队、`session_messages` 持久化、graph-runner 喂图，**无需特殊处理**。
- **系统提示**：libs/agent 的 system prompt（`PromptService.getPrompt("system")` 的源 prompt）增加一段，说明 `<llmuse>` 语义 + 引导按需调 IM 工具。

## 7. IM 工具（libs/agent 端口 + server-agent 绑定）

守 libs/agent 框架无关边界：新增 `IM_CONTEXT_PORT`（libs/agent 定义的 Symbol + 接口），server-agent 用 `CloudImService` 实现并绑定（仿 `RUNTIME_CONTEXT_PORT` / `QUICK_ASSISTANT_PORT` 模式）。

三个 builtin `@Tool`（账号作用域，经 `AccountContextService`；结果走既有 `capForLlm` / `TOOL_RESULT_LLM_LIMIT` 截断）：

| 工具 | 入参 | 映射 | 用途 |
|------|------|------|------|
| `im_unread_overview` | — | `CloudImService.listConversations()` | 列所有会话 + 未读数概览（item 2「多少未读消息」） |
| `im_read_conversation` | `conversationId`, `limit?`, `before?` | `CloudImService.getMessages()` | 拉某频道/私聊的聊天记录（item 3「当前会话内容」+ 跨会话深挖） |
| `im_list_members` | `conversationId` | `CloudImService.listChannelMembers()` | 频道成员（弄清「同事是谁」） |

`conversationId` 即页面 URL（`/messages?id=…`）里的 id，与 `<llmuse>` 会话行的 id 同源，模型可直接据此调用。

## 8. 数据流（典型）

```
频道页(id=321) 打开助手面板 → 输入「帮我看看怎么回」
  → 前端 buildLlmuseBlock() 拼 <llmuse>页面:消息 / 会话:频道「产品研发」(channel,id=321),未读5</llmuse>
  → 前置到 content → POST /api/sessions/:id/messages
  → PendingMessage 入队 → runner 认领 → graph-runner 喂图（含块）
  → supervisor 读到 id=321 与未读 → 决定调 im_read_conversation(321)
  → 拿到最近对话 → 综合给出回复建议
渲染：助手回复正常显示；用户那条消息经 stripLlmuse 后只显示「帮我看看怎么回」
```

## 9. 不变量

- 块**进** LLM 上下文（graph + checkpointer + `session_messages` 存档），**不进** UI 显示（渲染层剥离）。
- 标签字面量**单一来源**（共享常量），前端组装/剥离与系统提示三处一致。
- `<llmuse>` 仅 web-agent 用户→助手轮次注入；companion 不注入；只读工具全会话可用。
- 工具账号作用域不变量：所有 IM 工具经 `AccountContextService.getOrThrow()` 守账号隔离。

## 10. 后续可选（不在本期范围）

- `im_send_message(conversationId, content)`：助手替用户在频道/私聊发消息（写入类）。需额外确认权限/确认交互（避免误发）。
- ws/events 持续上报：若未来需要「用户没发消息时助手也主动感知」，再引入常驻上报 + per-account 临时态。

## 11. 测试

- **前端单测**：`buildLlmuseBlock` 覆盖各页面/会话形态（频道/私聊/非会话页/无会话）；`stripLlmuse` 覆盖多块/无块/畸形标签。
- **后端单测（jest）**：三个工具的端口绑定 + 账号作用域 + 结果截断；系统提示包含 `<llmuse>` 说明的断言。
- **不变量校验**：块进 LLM、不进 UI 显示（前端渲染快照测试或 strip 单测）。

## 12. 涉及文件（预估）

- 前端：`apps/web-agent/src/atoms/im.ts`（读状态）、新增 `llmuse` 工具（组装/剥离）、assistant composer 与助手面板发送路径、assistant 消息渲染组件。
- 共享：`libs/types-agent`（`<llmuse>` 标签常量）。
- 后端：libs/agent system prompt 源文件、libs/agent 新增 `IM_CONTEXT_PORT` + 三个 IM `@Tool`、server-agent 绑定模块（基于 `CloudImService`）。
