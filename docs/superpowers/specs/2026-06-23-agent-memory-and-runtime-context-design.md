# agent 记忆（分层自管理）+ 运行时上下文（system:ctx）设计

**日期：** 2026-06-23
**状态：** 待实施

## 背景与目标

给本地 agent 加**长期记忆**：跨会话记住用户偏好/事实/约定。本地可切换账号 → **全程按 cloudUserId 账号隔离**（与 skills / prompt 同范式）。

记忆采用业界主流的**分层自管理（MemGPT/Letta 范式）**：常驻 core + 按需检索 archival，agent 用工具自行决定记什么（self-editing），非黑盒自动抽取。

并补一条**运行时上下文基建** `system:ctx`：把当前 cloudUserId / sessionId 等"运行时身份"显式放进会话上下文，作为今后任何功能从会话态读取运行时上下文的唯一规范位。

本项目含两个组件：**A. system:ctx 基建**（基础，先行）、**B. agent 记忆**（主功能）。

---

## 组件 A：system:ctx 运行时上下文消息

### A1. 形态
一条 **稳定 id = `"system:ctx"`** 的 `SystemMessage`，存于 LangGraph 会话态（checkpointer），**LLM 可见**，承载当前运行时上下文。

### A2. 字段（每 run 刷新，LLM 可读的紧凑块）
```
<context>
cloudUserId: <雪花 id>
sessionId: <会话 id>
user: <账号 displayName>
model: <当前模型标识>
language: <界面语言 / locale>
timezone: <IANA 时区，如 Asia/Shanghai>
</context>
```
- **不含当前日期时间（now）**：静态 now 写进会话态会造成时间误导（模型可能拿旧快照当权威推算）。实时时间一律走 `date` 工具；`date` 工具/时间解释用本块的 `timezone` 即可。
- `timezone` 稳定不误导，故存。

### A3. 刷新机制
- **每次 run 前**：在 `runGraphStream` 的输入里前置 `[RemoveMessage("system:ctx"), new SystemMessage({ id: "system:ctx", content })]`。
- 复用 `graph.builder` reducer **既有的 RemoveMessage 处理**（按 id 删 + append）：旧 ctx 被删、新 ctx 追加，**原地刷新不累积**。
- 位置：随每轮输入追加，落在历史之后、本轮 human 之前（当前上下文紧贴问题，recency 友好）。`resumeStream`（无新 human）同样刷新一条。
- 与现有「系统提示仅首轮注入、无 id」并存：系统提示是 persona/指令（首轮注一次），system:ctx 是运行时态（每 run 刷新）。

> **跨 provider 风险（实现期必验 + 兜底）**：system:ctx 是**非首位**的 SystemMessage（落在历史之后）。部分 provider/适配层仅接受首位 system（如 Anthropic 把 system 提取为独立 param，多条/非首位 system 行为不一）。实现首步用集成测试在目标 provider（deepseek / anthropic / openai 兼容 / google）验证：非首位 system 能被正确下发且不报错。若有 provider 不兼容，兜底方案：①改用 `HumanMessage`/带前缀的消息承载 ctx；或 ②增强 builder reducer 让同 id 消息「原地替换」（保持 ctx 紧随主系统提示之后的首部位置），而非 append 到末尾。优先保 LLM 可读 + 不累积两点。

### A4. 字段来源（实现期接线）
- `cloudUserId` = `AccountContextService.getOrThrow()`；`sessionId` = threadId。
- `model` = `GraphService.modelMeta`。
- `displayName` / `language` / `timezone` = 账号身份 / 设置（来源在 plan 期确认：cloud_identity / settings；缺省兜底）。
- ctx 组装为 `GraphService` 的一个私有方法 `buildContextMessage()`，run 前调用。

---

## 组件 B：agent 分层自管理记忆

### B1. 落点与隔离
- `MemoryService` 放 **libs/agent**（纯本地文件、无云依赖 → 不需端口，工具直接注入；区别于 skill-install 的端口）。
- 存储根：`accounts/<cloudUserId>/memory/`，经 `MeshbotConfigService.getMemoryDir()`（新增，复用 `getAccountDir` + `AccountContextService`，与 `getSkillsDir` 同范式）→ **切账号天然隔离**。

### B2. 两层
| 层 | 存储 | 召回 | 作用 | 约束 |
|----|------|------|------|------|
| **core** | `memory/core.md` | 每会话**注入系统提示** | 精炼用户画像/偏好/长期约定 | 大小上限（如 ≤2KB，超限工具报错让 agent 精简） |
| **archival** | `memory/archive/<id>.md` | `memory_search` **按需检索** | 海量细节事实 | 无 |

- `archive/<id>.md`：frontmatter（`id` / `title` / `tags` / `createdAt`）+ markdown 正文。`id` = 雪花，作文件名。
- 检索：扫 archive 目录，title/tags/正文**关键词匹配** + 按 `createdAt` recency 排序（小集合够用；向量/FTS 留升级位）。复用 skills 的 frontmatter 解析思路。

### B3. agent 工具（4 个，libs/agent/builtins，`@Tool` + 注入 MemoryService）
- `memory_core_write(content)`：整体重写常驻 core 块（agent 在系统提示里已见当前 core，整体改写；超大小上限报错）。
- `memory_add(content, title?, tags?)`：写一条归档记忆，返 id。
- `memory_search(query?, limit?)`：关键词 + recency 检索归档（空 query = 列最近 limit 条）。
- `memory_delete(id)`：删一条归档（幂等）。
- 注册进 `agent.module` providers。

### B4. 注入 / 召回
- **core**：系统提示组装时追加一个 `<memory>` 段 = **内置「记忆使用说明」**（何时该 `memory_add` / 更新 core / `memory_search`，避免记噪声）+ **当前 core.md 内容**。沿用「系统提示首轮注入」机制。
- **archival**：纯工具驱动（agent 判断相关时主动 `memory_search`）。**v1 不做会话开头自动 top-K 召回**（需查询词 + 易引噪声，留后续）。

---

## 数据流（一次会话 run）

1. `GraphService` 组装系统提示：persona/指令（PromptService）+ `<memory>`（说明 + core.md）。首轮注入 `SystemMessage`（无 id）。
2. 每 run 前置 `system:ctx`（RemoveMessage 旧 + 新 `buildContextMessage()`）。
3. 历史 + 本轮 human → LLM。
4. agent 按需：`memory_search` 查归档、`memory_add` 记新事实、`memory_core_write` 更新画像、`date` 取实时时间（用 ctx.timezone 解释）。

## 测试策略

- `MemoryService`（vitest）：core 读/写/大小上限；archival add/search（关键词+recency）/delete；账号隔离（不同 account 目录不串）。
- 4 个工具（vitest）：假 MemoryService，断言 args 校验 + 调 service + 结果序列化（仿 schedule-tools.spec / skill-tools.spec）。
- `system:ctx`：`buildContextMessage` 字段正确；run 前 RemoveMessage("system:ctx") + 新消息注入（graph.service 测试，仿既有 streamMessage harness）；刷新不累积（连续两 run 状态里只有一条 system:ctx）。
- core 注入系统提示的组装测试。
- 收尾：`pnpm typecheck`、`pnpm check` 全绿。

## 账号隔离（贯穿）

- `getMemoryDir()` = `accounts/<cloudUserId>/memory/`，`getOrThrow()` 强制账号上下文；工具在 run 内执行（账号 ALS 可用），与 skills 同机制。
- `system:ctx.cloudUserId` 来自 `AccountContextService` → 切账号即不同身份。

## 边界 / 非目标（v1）

- 不存 `now`（实时时间走 `date` 工具）；`system:ctx` 不放任何易变时间快照。
- 不做向量 / 语义检索（小集合 keyword + recency 够用，留升级位）。
- 不做会话开头自动召回归档。
- 不做记忆管理 UI（agent 自管理；UI 可作后续一期，像技能页）。
- 不引入 `memory_update`（改归档 = delete + add，YAGNI）。

## 实施顺序

- **Phase 1（system:ctx 基建）**：reducer 验证 + `buildContextMessage` + run 前刷新注入 + 字段来源接线 + 测试。更基础，且 memory core 注入复用同一「系统提示/上下文组装区」。
- **Phase 2（记忆）**：`getMemoryDir` + `MemoryService` + core 注入系统提示 + 4 工具 + agent.module 注册 + 「记忆使用说明」内置文案 + 测试。
