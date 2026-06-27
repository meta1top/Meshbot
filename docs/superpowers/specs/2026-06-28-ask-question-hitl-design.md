# 问题选项（ask_question，HITL）设计

> 状态：已通过 brainstorm，待评审 → writing-plans
> 日期：2026-06-28
> 关联：[[2026-06-27-im-send-message-hitl-design]]（同款 HITL 基础设施，本功能复用并泛化它）

## 1. 目标

给 agent 一个 `ask_question` 工具：需要用户决策时，弹出一组问题（1–4 个，仿 Claude Code AskUserQuestion），每个问题带若干选项（label + 可选 description）、单选/多选、并固定附一个「其他」自定义输入。agent 挂起等用户提交，拿到选择后续答。

## 2. HITL 复用（方案 B：泛化 ConfirmationService）

`ConfirmationService`（[[2026-06-27-im-send-message-hitl-design]] 建的挂起/解锁/超时/abort 核心）当前 `decision` 耦合 im_send 专用的 `{action: send|cancel}`。本功能把它**泛化为通用挂起核心**，两个 HITL 共用：

- `ConfirmationService` 改：`pending: Map<string, (d: unknown) => void>`；`waitForDecision<T>(key, signal, timeoutMs): Promise<T | "timeout" | "aborted">`；`resolve<T>(key, decision: T): boolean`。`static key(...)` 不变。
- im_send 仅 `ImSendService.confirmAndSend` 一处把调用改为 `waitForDecision<ConfirmDecision>(...)`（`ConfirmDecision` 类型保留，行为不变）；im_send 的 `/confirm` 端点 / schema / 卡 **不动**。
- ask_question 加**自己的一套**（工具/port/service/端点/卡），用泛化后的 `ConfirmationService`。

（否决：A = 把 `/confirm` 端点也泛化、两个 HITL 共用一个端点，改动已上线 im_send 面更大；C = ask 自带挂起 service，重复超时/abort 逻辑，不 DRY。）

## 3. schema（types-agent）

- 工具入参 `askQuestionSchema`：
  ```
  questions: Array<{
    question: string;            // 问题文本
    header?: string;             // 短标签（可选）
    options: { label: string; description?: string }[];  // 至少 1 项
    multiSelect: boolean;        // 单选 false / 多选 true
  }>                             // 1–4 个问题
  ```
- 回传端点入参 `answerQuestionsSchema`：
  ```
  toolCallId: string;
  answers: Array<{ selected: string[]; other?: string }>;  // 按 question 顺序对齐
  ```
  `selected` 装用户选中的 option label（单选时长度 ≤1）；`other` 是「其他」文本（空则省略）。

## 4. 工具 `ask_question`（libs/agent builtin）

- 参数 `askQuestionSchema`；`execute` 经 `ASK_QUESTION_PORT.ask({ sessionId: ctx.sessionId, toolCallId: ctx.toolCallId, questions }, ctx.signal)` 挂起等回答，把返回的 JSON 字符串原样给 agent。
- `description`：引导 agent——当确实需要用户在几个明确选项间做决策时用；每问题给清晰 label（必要时 description）；单事实/可自行决定的不要用（避免打断）。
- 守 libs/agent 边界：纯 `@Tool()`，只依赖 `ASK_QUESTION_PORT`（返回 string）。注册进 AgentModule。

## 5. 端口 `ASK_QUESTION_PORT`（libs/agent）

```
export const ASK_QUESTION_PORT: symbol;
export interface AskQuestionPort {
  /** 弹问题卡、挂起等用户提交；返回结果 JSON 字符串：
   *  {"status":"answered"|"timeout"|"interrupted", answers?: [...]}。fail-safe：超时/中断不算回答。 */
  ask(
    params: { sessionId: string; toolCallId: string; questions: AskQuestion[] },
    signal: AbortSignal,
  ): Promise<string>;
}
```

## 6. 后端绑定（server-agent）

- `AskQuestionService`（实现 `AskQuestionPort`）：`key = ConfirmationService.key(account.getOrThrow(), sessionId, toolCallId)`；`waitForDecision<AnswerPayload>(key, signal, ASK_CONFIRM_TIMEOUT_MS=120_000)`；映射 `answered`（带 answers）/ `timeout` / `aborted`(→interrupted)，返回 JSON 字符串。
- `@Global AskQuestionModule`：providers 绑 `ASK_QUESTION_PORT` → `AskQuestionService`（useExisting），复用全局 `ConfirmationService`（由 ImSendModule @Global 导出）。注册进 app.module。
- 端点 `POST /api/sessions/:sessionId/answer`，body `answerQuestionsSchema`：`key = ConfirmationService.key(account.getOrThrow(), sessionId, toolCallId)`；`ConfirmationService.resolve(key, { answers })`；返回 `{ ok: true }`（幂等）。`SessionController` 加该方法（薄）。

## 7. 前端（web-agent）

- `tool-call-block` 特判 `tool.name === "ask_question" && tool.status !== "streaming"` → `AskQuestionCard`（仿 `im-send-confirm-card`）。
- `AskQuestionCard`：从 `tool.args.questions` 渲染每个 question 一块——header + 问题文本 + 选项（`multiSelect` → checkbox，否则 radio；每项 label + description）+ 末尾固定「其他」勾选 + 文本框。本地 state 收集每问题的 `{selected, other}`。底部一个「提交」按钮 → `confirmAnswers(sessionId, toolCallId, answers)`（rest 封装 → `POST /answer`）。in-progress（`status==="running"`）显示可填表单；end（`ok`）解析 `tool.result` 显示已提交摘要 / 超时 / 取消。
- Rules of Hooks：特判早返回放在 `useState` 之后（同 `im_send_message` 特判位置）。
- 硬编码中文 OK（同卡片范式）。

## 8. 数据流

```
agent 调 ask_question(questions) → tool 流式 → 前端渲染 AskQuestionCard
工具 execute 经 ASK_QUESTION_PORT.ask 挂起（waitForDecision，race 超时+abort）
用户填表点提交 → POST /api/sessions/:id/answer {toolCallId, answers}
  → ConfirmationService.resolve(key, {answers}) → 解锁 → AskQuestionService 返回 {status:"answered",answers}
  → 工具返回 → agent 拿到用户选择续答
超时/Stop → 返回 {status:"timeout"|"interrupted"} → agent 如实告知
```

## 9. 边界 / 不变量

- **fail-safe**：超时 / abort / 未提交 → 非「answered」；agent 据此续答。
- **「其他」始终附加**；`multiSelect` 决定 radio vs checkbox；`answers` 按 question 顺序对齐。
- **账号作用域**：answer 端点 key 含 `account.getOrThrow()` 的 cloudUserId，跨账号无法解锁（同 im_send）。
- **单例 ConfirmationService 不变量**：仍由 ImSendModule @Global 提供唯一实例，im_send 与 ask_question 的 await/resolve 用同一实例（命门，勿重复 provide）。
- 仅「用户→助手」会话用（工具全会话可注册；companion 已删，无关）。

## 10. 测试 / 验证

- **回归保护**：`ConfirmationService` 泛型化后，**im_send 全套测试仍绿**（confirmation.service.spec / im-send.service.spec / session-confirm.controller.spec）+ 新增泛型用例（resolve/waitForDecision 任意 payload）。
- `AskQuestionService.ask`：answered（断言经泛型 waitForDecision、映射 answers）/ timeout / aborted 各分支。
- 工具 `ask_question` 透传单测（mock port）。
- answer 端点单测（key 含 cloudUserId、resolve 透传 answers、幂等）。
- schema 单测（questions 1–4、options 非空、multiSelect、answers 对齐）。
- 前端纯函数（答案收集/校验，如「单选 selected ≤1」「其他文本组装」）jest。
- **boot 验证（必做）**：新 `@Global AskQuestionModule` + DI；启动 successfully started + 监听 3100、无解析报错。

## 11. 涉及文件（预估）

- types-agent：`ask-question.ts`（askQuestionSchema + answerQuestionsSchema + 类型）+ index。
- libs/agent：`tools/ask-question.port.ts`、`tools/builtins/ask-question.tool.ts`、agent.module 注册、index 导出、工具 vitest。
- server-agent：`services/confirmation.service.ts`（泛型化）、`services/im-send.service.ts`（一处加泛型）、`services/ask-question.service.ts`、`ask-question.module.ts`、`session.controller.ts`（answer 端点）、`dto/session.dto.ts`（AnswerDto）、`app.module.ts`（注册）、相关 spec。
- web-agent：`rest/session.ts`（confirmAnswers）、`components/session/ask-question-card.tsx`、`tool-call-block.tsx`（特判）、可能 `lib/ask-answer.ts`（纯函数）+ jest。
