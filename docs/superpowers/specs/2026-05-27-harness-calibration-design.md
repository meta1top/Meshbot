# Harness 校准 + agent 域治理 — 设计稿

> 日期：2026-05-27
> 背景：项目迭代一段时间后，对规则 / 围栏 / 技能（Harness）做一次现状体检与校准。

## 现状诊断

Harness 核心机制成熟（6 个静态围栏 + 增量 baseline、pre-commit 链路完整、CI 齐全、规则↔技能 1:1 同步）。但出现三类问题：

1. **源头模型已不匹配实际工作流**：`.cursor/rules/*.mdc` 是唯一源，`.claude/skills/` 由 `sync-skills` 派生。用户现已主用 Claude Code，Cursor 弃用，导致"编辑生成物"的倒置。
2. **`agent-arch` 规则（`alwaysApply: true`）内容过时且错误**：引用不存在的 `libs/shared`、已重命名的 `packages/common`，遗漏 `libs/agent` 等，且提及未使用的 LanceDB。
3. **CLAUDE.md 局部事实性过时**：DB 规范节称本地轨"当前用 `synchronize: true`（Phase 3 切换迁移）"，但实际已是 `synchronize:false` + `migrationsRun:true` + 8 个迁移文件（与本文件表归属节自相矛盾）；Entity 表漏列 `LlmCall` / `SessionMessage`。
4. **围栏覆盖盲区**：近期开发主战场（context compaction、MCP、渐进式 skill 工具）几乎全在 agent 域，而 `libs/agent` 被静态围栏显式排除，治理它的只有过时的 `agent-arch` 一条薄规则。

## 范围（五条工作线）

### A. 源头模型迁移（Cursor → Claude Code）

- 删除 `.cursor/rules/`（17 个 `.mdc`）
- 删除 `scripts/sync-skills.ts`，移除 `package.json` 的 `sync:skills` 命令
- pre-commit 移除 `pnpm sync:skills -- --check` 行（及其 echo）
- `.claude/skills/*/SKILL.md` 转正为**唯一源**，今后直接编辑
- `scripts/README.md` 删除 sync-skills 表行与"sync-skills 模式"小节，并移除"唯一源是 .cursor/rules"的表述

> 注：SKILL.md 现有 frontmatter（`name:` + `description: … [Use when matching: <globs>]`）是 sync-skills 的生成格式，转正后原样保留即可，Claude Code 正常识别。

### B. 事实性修正

- **CLAUDE.md**
  - 数据库规范节：把"本地轨当前用 `synchronize: true`（Phase 3 切换到迁移文件）"改为已切迁移的事实（`synchronize:false` + `migrationsRun:true` + 迁移文件管理），消除与表归属节的矛盾。
  - 表归属表：server-agent Entity 补 `LlmCall` / `SessionMessage`。
  - **不动 Phase 进度等其余内容**（由用户自行维护）。
- **pre-commit**：echo `"running 5 static fences"` → `"6"`（功能本就跑 6 个，仅文案误导）。
- **agent-arch（见 C，合并处理目录结构纠错）**

### C. agent 域规则补全（重头）

把"基础结构总览"留在 CLAUDE.md（always-on），把 `agent-arch` 技能改造为**按需调用的 agent 域深度约定文档**，去掉与 CLAUDE.md 重复的应用结构表，编入以下实证约定（均有代码出处）：

- **libs/agent 边界纪律**：只允许 `@Injectable` + 生命周期钩子（`OnModuleInit`/`OnModuleDestroy`）；禁 `@InjectRepository`/`@Entity`/`@Controller`/HTTP 装饰器；测试用 **vitest**（非 jest，jest.config 已排除）；纯工厂函数（`create*`/`build*`）。理由：保持 libs/agent 框架无关、可独立集成测试。
- **分层职责**：`libs/agent` = 框架无关 LLM 编排（LangGraph / prompt / tool registry / MCP bridge / skills 扫描）；`apps/server-agent` = HTTP + DB + session 路由 + 持久化（ContextCompactor 包 GraphService，RunnerService 编排两者）。单向依赖。
- **checkpointer 不变量**：resume 前必 `sanitizeOrphanToolCalls`（去尾部无 ToolMessage 的 tool_calls，防 LLM 400）+ `cutMessagesAfter`（剪上次失败残留）；压缩后消息序固定 `[system, summary, ...keep]`；split 不可切断 tool_call/tool_result 对（`expandToToolBoundary`）。
- **双截断模式**：tool 结果 history 存全量 / 喂 LLM 截断（`TOOL_RESULT_LLM_LIMIT = 32_000`，保 a11y 快照、砍 base64 膨胀）。
- **命名常量纪律 + 配置债**：compaction 阈值（`COMPACTION_TRIGGER_RATIO 0.9` / `RECENT_RATIO 0.1` / `SUMMARY_MAX_TOKENS 1500` / `SUMMARIZE_TIMEOUT_MS 60_000`）v1 硬编码，v2 迁 ModelConfig；recursion 上限默认 100、`MESHBOT_GRAPH_RECURSION_LIMIT` 可配。
- **MCP/tool 命名**：MCP 工具前缀 `mcp__<server>__<tool>`。

> 同时纠正 agent-arch 原有错误：`libs/shared`→`libs/common`、`packages/common`→`packages/web-common`、补齐 `libs/agent`/`types-agent`/`types-main`/`cli-agent`、移除未使用的 LanceDB 表述（或明确标注为规划项）。

### D.（已取消）

PHASE_HISTORY 不补 Phase 7，Phase 相关由用户自行提需求。

### E. 静态围栏评估 → 结论：暂不新增第 7 个 fence

- **理由**：agent 域不变量是**语义级**的（LangGraph 消息序、tool_call/result 配对、压缩 split 边界），难以用低成本静态 AST 表达；agent 域高速迭代，静态脚本维护成本高；现有 6 围栏均针对稳定的 NestJS 服务层结构规则。
- **替代守护**：编入 agent-arch 规则（C） + 人审/agent 审 + 关键不变量用 `libs/agent` 的 **vitest 单测**覆盖（已部分覆盖，如 compaction reorder / tool-boundary）。
- 该评估结论在此存档，将来 agent 域结构稳定后可复盘是否值得加 fence。

## 验收

- `pnpm check`（6 围栏）通过
- pre-commit 跑通（不再含 sync:skills 步骤）
- `.cursor/` 目录已删除，仓库内无对 `.cursor/rules` / `sync:skills` 的残留引用
- `pnpm sync:skills` 命令已移除，`scripts/README.md` 不再提它
- agent-arch SKILL.md 目录结构与现实一致，含 agent 域约定
- CLAUDE.md 的 DB 规范与 Entity 表与现实一致
