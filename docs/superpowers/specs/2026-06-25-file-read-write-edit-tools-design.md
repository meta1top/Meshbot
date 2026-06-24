# 助手文件读写编辑能力设计（Read / Write / Edit / Grep / Glob）

**日期：** 2026-06-25
**状态：** 待实施

## 背景与目标

给本地 agent（`libs/agent` + `apps/server-agent`）加一套**文件读写编辑能力**，借鉴 Claude Code 的工具设计，让助手能像主流 code agent 一样操作文件系统。

现状：agent 域只有 `BashTool` 能间接读写文件（cwd 锁 `~/.meshbot/workspace/`），无专用文件工具，权限/语义不清晰。

本期交付 **5 个工具 + 1 个支撑 Service + 1 条新流式协议**：

- `read_file` / `write_file` / `edit_file` / `grep` / `glob`
- `FileStateService`（新鲜度追踪，支撑 read-before-write 铁律）
- `run.tool_call_args_delta`（流式实时预览：边生成边在前端"打字"）

### 关键决策（来自 brainstorm）

| 维度 | 决策 |
|------|------|
| 借鉴对象 | Claude Code 的 Read/Write/Edit/Grep/Glob |
| 编辑定位方式 | **字符串精确匹配**（非行号/列号）。行号仅用于展示，**在 Node 进程内计算，不走 bash** |
| 流式写入语义 | **前端实时预览（方案 A）**：磁盘原子写，UI 边收 tool_call 增量 token 边逐字渲染 |
| 路径范围 | **全文件系统访问**（像 Claude Code 在开发机），不做沙箱 |
| 工具集 | Read + Write + Edit + Grep + Glob（**不含 MultiEdit**） |

---

## 复用的现有架构

- **工具接口** `MeshbotTool`（`libs/agent/src/tools/tool.types.ts`）：`name` / `description` / Zod `schema` / `execute(args, ctx)`。
- **`@Tool()` 装饰器**（`tool.decorator.ts`）+ NestJS `DiscoveryService` 自动注册到 `ToolRegistry`。
- **`ToolContext`**：`sessionId` / `messageId` / `toolCallId` / `emitter`（EventEmitter2 推流式事件）/ `signal`（AbortSignal 中断）。
- **结果双截断**（`tools.node.ts`）：完整结果落库给前端，32KB 截断给 LLM（`capForLlm`）。
- **范本** `BashTool`（`bash.tool.ts`）：路径解析、`ctx.emitter` 流式 `runToolCallProgress`、`ctx.signal` 中断、超时——文件工具沿用同款。

---

## 组件一：五个工具

全部置于 `libs/agent/src/tools/builtins/`，各一个 `@Tool()` 类，并注册进 `agent.module.ts` 的 providers。命名沿用 snake 约定（对照 `bash`/`memory_search`/`schedule_create`）。

### 1. `read_file`

**参数**：`{ file_path: string, offset?: number, limit?: number }`

- 绝对路径直用；相对路径对 workspace 解析。
- 输出 **`cat -n` 格式**：右对齐行号 + Tab + 行内容，从 `offset`（1-based）起编号，`limit` 默认 2000 行。
- **单行截断**：单行超 2000 字符截断，防一行撑爆上下文。
- **二进制探测**：探测到二进制（含 NUL 字节等）→ 报错而非吐乱码。图片/PDF 本期不做。
- 空文件 → 返回提示而非空串。
- **副作用**：把 `{ mtimeMs, size }` 写入 `FileStateService`（新鲜度依据）。

**返回**：行号化文本（受 32KB LLM 截断）。

### 2. `write_file`

**参数**：`{ file_path: string, content: string }`

- 路径解析同上。
- **文件已存在** → 必须本会话 `read_file` 过且未被外部改动（`FileStateService.assertFresh`），否则报错。
- **文件不存在** → 允许创建，**自动建父目录**（`mkdir -p`，助手常见需求）。
- **原子写**：写同目录临时文件 + `fs.rename`（同盘原子），杜绝半成品。
- 写完 `FileStateService.recordWrite` 刷新记录（避免随后的 Edit 误判过期）。

**返回**：`Wrote N lines to <path>`。

### 3. `edit_file`

**参数**：`{ file_path: string, old_string: string, new_string: string, replace_all?: boolean }`

- 新鲜度校验同 Write（文件必存在 + 本会话读过 + 未变）。
- **匹配语义**：
  - `replace_all=false`（默认）：`old_string` 必须**唯一命中**——0 处 → 报"未找到"；多处 → 报"不唯一，请加上下文或用 replace_all"。
  - `replace_all=true`：替换全部命中。
  - `old_string` 不得等于 `new_string`。
- 原子写 + 刷新记录。
- **返回编辑后的行号片段**：改动处 + 前后数行上下文，`cat -n` 风格。← 这是用户"返回行号"诉求的落点：**行号由工具在 Node 内计算，匹配靠字符串，二者解耦**。

### 4. `grep`

**参数**：`{ pattern: string, path?: string, glob?: string, type?: string, output_mode?: "files_with_matches" | "content" | "count", "-i"?: boolean, "-n"?: boolean, "-A"?: number, "-B"?: number, "-C"?: number, head_limit?: number }`

- **引擎 `@vscode/ripgrep`**：自带各平台预编译二进制，server 与 Electron 桌面均可跑，不依赖系统是否装 rg。
- `output_mode` 默认 `files_with_matches`，对齐 Claude Code Grep；默认遵守 .gitignore。
- 旗标映射到 rg 命令行，spawn 子进程，stdout 封顶（`head_limit` + 32KB 截断）。

**返回**：文件列表 / 内容行 / 计数。

### 5. `glob`

**参数**：`{ pattern: string, path?: string }`

- **引擎 `fast-glob` / `tinyglobby`**。
- 返回匹配路径，**按 mtime 倒序**（最近改的排前），结果数封顶。

**返回**：换行分隔的路径列表。

---

## 组件二：安全模型

全文件系统访问下，靠两条铁律 + 一个内存 Service 兜底。

### `FileStateService`（新增 `@Injectable` 单例）

- 纯内存，**无 Entity / 无 Repository**（故 `check:repo` / `check:tx` / `check:naming` 自然通过）。
- `Map<"${sessionId}::${absPath}", { mtimeMs: number, size: number }>`。
- 方法：
  - `recordRead(sessionId, absPath, stat)` — Read 工具调用。
  - `assertFresh(sessionId, absPath)` — Write（已存在）/ Edit 调用，不新鲜抛结构化错误。
  - `recordWrite(sessionId, absPath, stat)` — Write/Edit 写完刷新。
- 按 `ctx.sessionId` 隔离；会话销毁时清理（挂会话生命周期）或 LRU 封顶，防内存泄漏。
- 注入进 Read / Write / Edit 三工具。

### 两条铁律

1. **Read-before-Edit/Write**：改 / 覆写**已存在**文件前必须本会话先 `read_file`，且 mtime/size 未变；变了 → 拒绝并提示重读。新建文件不受此限。
2. **原子写**：临时文件 + rename。

### 本期不做（YAGNI，记为未来安全层）

- 全文件系统下的路径黑名单 / 系统关键路径拦截。
- 写操作的人在环确认弹窗（meshbot 当前无 tool 审批 / LangGraph interrupt 基建）。
- 仅做路径规范化（`path.resolve` + normalize）。

---

## 组件三：流式实时预览（方案 A）

本期唯一新增协议，也是最脆的一块。目标：把 LLM 生成 `write_file`/`edit_file` 的 `content`/`new_string` 参数的**增量 token** 推到前端，渲染"打字"效果。

> 约束本质：工具 `execute()` 只在参数攒齐后才跑，所以"边打边显示"的内容只能来自 LLM 生成 tool_call 时的增量。需把 LangGraph `messages` 流里的 `AIMessageChunk.tool_call_chunks` surface 到前端。

### 后端

**1. graph 层捕获**（`libs/agent/src/graph/graph.service.ts` stream 循环）
- `mode === "messages"` 时除现有 reasoning/content 外，新增读 `msg.tool_call_chunks`（每片 `{ name?, args(部分 JSON 串), id?, index }`），yield 新 kind `tool_call_args`：`{ messageId, index, id?, name?, delta }`。

**2. 新 WS 事件**（`libs/types-agent/src/session.ts`）
```
SESSION_WS_EVENTS.runToolCallArgsDelta = "run.tool_call_args_delta"
payload: { sessionId, messageId, index, toolCallId?, name?, delta }
```
- `apps/server-agent/src/ws/session.gateway.ts` 加 `@OnEvent` 转发到 sessionId 房间。
- **不落库**（瞬态；最终权威参数仍由现有 `run.tool_call_start` 攒齐后给出）。

**3. index ↔ toolCallId 对齐**
- 流式期 `tool_call_chunks` 通常只有稳定 `index`，`id` 后到。前端**先按 index 累积预览**，等 `run.tool_call_start`（带真 `toolCallId` + 完整 args）到达时用权威值收口、覆盖预览。

### 前端

**1. `apps/web-agent/src/hooks/use-session-stream.ts`**
- handle `run.tool_call_args_delta`，维护 `index → 累积 args 串`。
- **尽力部分解析**：用成熟库（`best-effort-json-parser` / `partial-json`），从未闭合 args 串抽 `file_path` + `content`（Write）/ `old_string` + `new_string`（Edit）。
- 必须容忍：字符串未闭合、转义字符截断、多 tool_call 并发。**解析失败绝不抛**，退回上一次成功值（单调揭示，不回退闪烁）。

**2. `apps/web-agent/src/components/session/tool-call-block.tsx`**
- write/edit 流式中：把抽出的 `content`/`new_string` 当文件预览**逐字渲染**。
- `run.tool_call_start` 到 → 锁权威值；`run.tool_call_end` 到 → 展示最终结果（编辑后行号片段 / 写入统计）。

---

## 测试策略（Jest，围栏必过）

- **五工具单测**：
  - Read：格式化 / offset / limit / 二进制探测 / 空文件。
  - Write：原子写 / 三类新鲜度错误（未读、已过期、正常）/ 自动建父目录。
  - Edit：唯一命中 / 0 命中 / 多命中 / replace_all / 新鲜度 / 返回行号片段。
  - Grep：旗标 → rg 命令行映射 / 三种 output_mode。
  - Glob：mtime 倒序排序 / 结果封顶。
- **FileStateService 单测**：record / assert / stale / refresh。
- **部分 JSON 解析单测（重点）**：把一段完整 Write args JSON 逐字符截断成 N 个前缀，断言解析器**从不抛异常**且 `content` 单调揭示、永不倒退。
- **围栏**：commit 前 `pnpm check`（`FileStateService` 无装饰器/无 Repository，围栏自然通过）。

## 错误处理

- 工具返回**可自纠的结构化错误串**（如 `file not read this session — call read_file first`、`string not unique — add more context or use replace_all`），由 `tools.node` 包成 ToolMessage 让 LLM 自行修正。

---

## 交付清单

**新增文件**
- `libs/agent/src/tools/builtins/read-file.tool.ts`
- `libs/agent/src/tools/builtins/write-file.tool.ts`
- `libs/agent/src/tools/builtins/edit-file.tool.ts`
- `libs/agent/src/tools/builtins/grep.tool.ts`
- `libs/agent/src/tools/builtins/glob.tool.ts`
- `libs/agent/src/tools/builtins/file-state.service.ts`
- 对应 `tests/unit/*.test.ts`

**改动文件**
- `libs/agent/src/agent.module.ts`（注册 6 个 provider）
- `libs/agent/src/graph/graph.service.ts`（捕获 `tool_call_chunks` → yield `tool_call_args`）
- `libs/types-agent/src/session.ts`（新增 `runToolCallArgsDelta` 事件 + schema）
- `apps/server-agent/src/ws/session.gateway.ts`（转发新事件）
- `apps/web-agent/src/hooks/use-session-stream.ts`（消费 + 部分解析）
- `apps/web-agent/src/components/session/tool-call-block.tsx`（流式预览渲染）

**新增依赖**
- `@vscode/ripgrep`、`fast-glob`（或 `tinyglobby`）、部分 JSON 解析库（`best-effort-json-parser` / `partial-json`）
