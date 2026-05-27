---
name: agent-arch
description: "Agent 域（libs/agent + server-agent）架构与编排约定 — 分层边界、checkpointer 不变量、上下文压缩、tool 截断、MCP。Use when working on libs/agent/** or apps/server-agent/** agent orchestration code (graph/runner/compaction/MCP/tools), or when explicitly invoked."
---

# Agent 域架构与编排约定

> 基础应用结构（apps / libs / packages 目录划分、两轨依赖方向）以 `.claude/CLAUDE.md` 的「项目架构」节为准，本文件不重复，只覆盖 **agent 域**（`libs/agent` + `apps/server-agent` 的编排层）的深度约定。

## 分层职责

| 层 | 目录 | 职责 |
|----|------|------|
| LLM 编排 | `libs/agent/` | **框架无关**：LangGraph 图、prompt、tool registry、MCP bridge、skills 扫描。零数据库、零 HTTP |
| 后端集成 | `apps/server-agent/` | NestJS HTTP + DB 持久化 + session 路由：`Session` / `SessionMessage` / `LlmCall` 等 Entity、`RunnerService`、`ContextCompactorService` |

单向依赖：`server-agent` → `libs/agent`。`ContextCompactor` 包 `GraphService`；`RunnerService` 编排两者。

## libs/agent 边界纪律（无静态围栏，靠本约定 + 人审 + vitest）

静态围栏（`pnpm check:*`）**显式排除 `libs/agent/`**，因此以下纪律靠约定守护：

- **只允许** `@Injectable()` + 生命周期钩子（`OnModuleInit` / `OnModuleDestroy`）。
- **禁止** `@InjectRepository` / `@Entity` / `@Controller` / 任何 HTTP / TypeORM 装饰器。所有 I/O 下沉给调用方（checkpointer 是注入的抽象）。理由：保持 libs/agent 框架无关、可脱离 HTTP 栈独立集成测试。
- **测试用 vitest**（非 jest）；`jest.config` 已排除 `libs/agent/`。
- 纯逻辑写成工厂函数（`create*` / `build*`），有状态的才落 `*Service`。

## checkpointer 不变量（改 graph / runner 必读）

- **resume 前**必须先 `sanitizeOrphanToolCalls`（删尾部有 `tool_calls` 但无对应 `ToolMessage` 的 AIMessage，否则 LLM 报 400）+ `cutMessagesAfter`（剪掉上次失败尝试的残留 assistant/tool 消息）。
- **压缩后消息序固定 `[system, summary, ...keep]`**：reducer 先按 RemoveMessage 删除，再 concat 新序。改 reducer 勿破坏此顺序。
- **split 不可切断 tool_call / tool_result 对**：`expandToToolBoundary` 把切点左移以包含完整配对。新增任何"截断/裁剪消息"的逻辑都要保持配对完整。
- regenerate 走 `kickResume`（`runOnce(sessionId, [], resume=true)`）——不新增 HumanMessage，复用 checkpointer 里已有的用户消息。

## 上下文压缩（ContextCompactor）

- **per-session 锁**：`locks` Map 去重并发 `compact()`；同 sessionId 第二次调用 await 第一次，`.finally()` 清理。
- **触发**：pre-check `shouldCompact(lastInputTokens, ctx)`（比值 ≥ `COMPACTION_TRIGGER_RATIO`）；兜底 `isContextLengthError` 捕获各家 provider 的 context-exceeded 错误后 `force=true` 重试。
- **保留预算** = `ctx * COMPACTION_RECENT_RATIO`；keep 至少 2 条。
- **配置债**：阈值 v1 硬编码常量（`COMPACTION_TRIGGER_RATIO=0.9` / `RECENT_RATIO=0.1` / `SUMMARY_MAX_TOKENS=1500` / `SUMMARIZE_TIMEOUT_MS=60_000`），v2 计划迁入 `ModelConfig`。新增阈值请同样用具名常量，勿散落魔数。

## tool 结果双截断模式

tool 结果有**两份**，勿混用：
- **history 全量**：写 `session_messages`（`recordAssistant` 的 `content`），用户/前端看完整结果。
- **喂 LLM 截断**：`llmContent = capForLlm(content)`，写进 checkpointer 的 `ToolMessage`，阈值 `TOOL_RESULT_LLM_LIMIT = 32_000`（保住 a11y 快照 ~12–22KB，砍掉 base64 截图等膨胀）。
新增"塞进 LLM 上下文"的内容都应过这道截断。

## LangGraph / MCP / 工具

- **recursion 上限默认 100**（非 LangGraph 默认 25），`MESHBOT_GRAPH_RECURSION_LIMIT` env 可配。一个 supervisor↔tools 往返 = 2 super-step。
- 图为两节点：`supervisor`（LLM 决策）+ `tools`（执行），`routeAfterSupervisor` 按是否有 `tool_calls` 路由到 tools 或 END。
- **MCP 工具命名** `mcp__<server>__<tool>`（`additionalToolNamePrefix: "mcp"` + `prefixToolNameWithServerName`）。MCP 从 `<meshbotDir>/mcp.json` 加载；文件缺失 = 静默 no-op，连接错误非致命（`onConnectionError: "ignore"`）。
- skill 工具（`skill-list` / `skill-load`）是静态 `@Tool` provider；`SkillService` 每次调用重扫盘（不缓存，便于热更新）。
