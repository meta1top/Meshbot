# Agent 编辑器 v2 第二段（工具启停 + F2 注入对称性）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** per-agent 内建工具启停（`tools.json` + ToolRegistry 过滤 + 豁免 + 分组工具 tab）+ 终审 F2 携带项（系统消息注入改无条件 Remove + 条件重建）。

**Architecture:** `ToolPrefsService`（libs/agent，读写 tools.json、读取时剔除豁免项）；ToolRegistry 三个消费口统一过滤内建工具（MCP 桶不过滤、ALS 外不过滤）；`TOOL_GROUPS`/`PROTECTED_TOOLS` 放 libs/types-agent 前后端共享。F2 独立小任务与 Task 1 并行。

**Tech Stack:** vitest（libs/agent）· jest（server-agent/web-common）· 无新依赖

**Spec:** `docs/superpowers/specs/2026-07-26-agent-editor-v2-design.md` §四（逐字为准）

## Global Constraints

- 存储逐字：`<agentDir>/tools.json` = `{ "disabledTools": string[] }`；缺失 = 全启用；人机共写
- `PROTECTED_TOOLS = ["todo_write", "ask_question"]`（libs/types-agent 具名常量）：写进 tools.json 也无效（**读取时剔除**），UI 灰置带提示
- 过滤点只在 ToolRegistry 的 `asLangChainBindable()` / `list()` / `get()`：只过滤**全局内建 entries**；MCP 桶（agentEntries）不过滤；无 Agent ALS 上下文时不过滤
- 写 tools.json **无需 teardown**（内建工具 bind 每 run 现算，下一轮自然生效）；工具返回/UI 文案沿用「下一轮对话生效」语义
- F2 语义：两条注入路径（streamMessageImpl 与 resumeStream 刷新段）对 skills/mcp/prompts 三条一律**无条件 `RemoveMessage` + hasX 条件重建**；persona/ctx 现状不动。RemoveMessage 对不存在 id 必须安全（vitest 验证，不安全则改为带存在性检查的实现并注明）
- libs/agent：vitest、禁 HTTP/TypeORM；**改构造器签名必跑全量 vitest**；改 DI/新 REST 真 boot（验完杀 7727）
- 中文注释；中文 conventional commits + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>；每任务 `pnpm format`
- 工作分支 `feat/agent-editor-v2-phase2`（已建）

---

### Task 1: TOOL_GROUPS/PROTECTED_TOOLS + ToolPrefsService + ToolRegistry 过滤（TDD vitest）

**Files:**
- Modify: `libs/types-agent/src/agent.ts`（或新建 `libs/types-agent/src/tools.ts` 并从 index 导出——若 agent.ts 已臃肿则分文件）
- Create: `libs/agent/src/tools/tool-prefs.service.ts`
- Modify: `libs/agent/src/tools/tool-registry.ts`（三消费口过滤）
- Modify: `libs/agent/src/agent.module.ts` + `libs/agent/src/index.ts`
- Test: `libs/agent/src/tools/tool-prefs.service.spec.ts` + `tool-registry` 现有 spec 增量

**Interfaces:**
- Produces（types-agent）:

```ts
/** 内建工具豁免清单：HITL 与进度呈现是会话骨架，禁用会让会话行为诡异难排查。 */
export const PROTECTED_TOOLS = ["todo_write", "ask_question"] as const;
/** 内建工具分组（工具 tab 展示用；未登记的工具归 "other"，新增工具不阻塞）。 */
export const TOOL_GROUPS: Record<string, string[]> = {
  filesTerminal: ["bash", "read_file", "write_file", "edit_file", "glob", "grep"],
  memory: ["memory_add", "memory_core_write", "memory_delete", "memory_search"],
  skills: ["skill_install", "skill_list", "skill_load", "skill_publish", "skill_search_market", "skill_uninstall"],
  im: ["im_list_members", "im_read_conversation", "im_send_message", "im_unread_overview"],
  drive: ["drive_create_share", "drive_download", "drive_fetch_share", "drive_list", "drive_mkdir", "drive_share", "drive_upload"],
  schedule: ["schedule_create", "schedule_delete", "schedule_list"],
  subagent: ["dispatch_subagent"],
  mcpManage: ["mcp_disable", "mcp_enable", "mcp_install", "mcp_list", "mcp_uninstall"],
  interaction: ["present_file", "todo_write", "ask_question"],
  other: ["date", "rename_agent"],
};
export const ToolPrefsSchema = z.object({ disabledTools: z.array(z.string()).default([]) });
export type ToolPrefs = z.infer<typeof ToolPrefsSchema>;
```

- Produces（ToolPrefsService，对照 PromptFileService 形态：MeshbotConfigService 注入 + Agent ALS）: `getDisabledTools(): ReadonlySet<string>`（读 `<agentDir>/tools.json`；缺失/损坏返回空集并 warn；**剔除 PROTECTED_TOOLS**）/ `setDisabledTools(names: string[]): void`（剔除豁免 + 去重 + Zod 校验 → `JSON.stringify(_, null, 2)` 落盘惰性 mkdir）。`MeshbotConfigService.getToolsConfigPath()` 新增（`<agentDir>/tools.json`，对照 getMcpConfigPath）
- ToolRegistry：`@Optional` 注入 ToolPrefsService；三消费口对**全局 entries**按 `getDisabledTools()` 过滤（`get(name)` 命中禁用返回 undefined 与未注册同表现）；ALS 外（getDisabledTools 抛错）catch 后不过滤——用 try/catch 或 hasAgentContext 判定，选与 McpService 一致的最小实现

- [ ] **Step 1: 失败测试**：ToolPrefsService——缺失文件空集/损坏 JSON 空集+不抛/写读回环/豁免写入被剔除（set 后文件里没有、get 也没有）/去重；ToolRegistry——禁用集生效（bindable/list/get 三口）/MCP 桶不受影响（agentEntries 里同名 mcp__ 工具仍在）/ALS 外全量返回
- [ ] **Step 2: 实现到全绿**　`pnpm --filter @meshbot/lib-agent test`（全量，注意构造器签名变更连带 tests/unit 对位）
- [ ] **Step 3: 提交**　`feat(agent): per-agent 工具启停——tools.json + ToolRegistry 过滤 + 豁免与分组`

---

### Task 2: F2 注入对称性（与 Task 1 并行，文件集不重叠）

**Files:**
- Modify: `libs/agent/src/graph/graph-runner.service.ts`（两条路径：~:148-163 streamMessageImpl 的条件 push 段、~:200-220 resumeStream 刷新段）
- Test: `libs/agent/tests/unit/graph-runner.test.ts` 或 `src/graph` spec 增量（选现有 graph-runner 测试所在处）

**Interfaces:** Consumes: `hasSkills/hasMcp/hasPrompts` 与三个 build*Message（不变）

- [ ] **Step 1: 失败测试**：老会话 checkpoint 含 `system:prompts` 而 `hasPrompts()` 现为 false → 下一轮后消息序列中无该 id（skills/mcp 同构参数化）；RemoveMessage 对不存在 id 不抛错不残留（新会话首轮路径回归）
- [ ] **Step 2: 实现**：两路径三条消息统一「无条件 Remove + hasX 条件重建」：

```ts
    // 可选系统消息（skills/mcp/prompts）：无条件 Remove + 条件重建——
    // hasX 从 true 翻 false（如删光提示词文件/卸载全部 MCP）时，老会话
    // checkpoint 里的旧消息必须清掉，否则残留旧人格/旧清单（终审 F2）。
    inputMessages.push(new RemoveMessage({ id: "system:skills" }));
    if (this.contextBuilder.hasSkills()) {
      inputMessages.push(this.contextBuilder.buildSkillsMessage());
    }
    // mcp / prompts 同构
```

（若 vitest 证明 RemoveMessage 空 id 在本仓 langgraph 版本会抛/残留，改为读 checkpoint 现有 id 集过滤后 Remove，并在注释写明原因。）
- [ ] **Step 3: 全量 vitest + 提交**　`fix(agent): 可选系统消息注入改无条件 Remove——修 hasX 翻 false 后老会话残留（终审 F2）`

---

### Task 3: REST /api/agents/:id/tools + boot（依赖 Task 1）

**Files:**
- Modify: `apps/server-agent/src/controllers/agent.controller.ts`（GET/PUT，对照 prompts 端点写法：findOrThrow + agentCtx.run + Swagger 完整声明）
- Modify: `libs/types-agent`（GET 响应 DTO schema：`{ groups: { key, tools: { name, disabled, protected }[] }[] }`——分组序按 TOOL_GROUPS 定义序，未登记工具并入 other）
- Test: `agent.controller.spec.ts` 增量（jest）

**Interfaces:**
- Consumes: `ToolPrefsService`、`ToolRegistry.list()`（拿全量内建名——**注意**：list() 会被 Task 1 的过滤影响，GET 需要**未过滤**的全量内建清单——ToolRegistry 需暴露 `listBuiltinsUnfiltered()` 之类只读口（Task 1 一并产出，本 task 消费；两 task 若并行实施由 Task 1 先行，本 task 串后）
- Produces: `GET /api/agents/:id/tools` → 分组全量 + disabled/protected 标记；`PUT /api/agents/:id/tools` body `{ disabledTools: string[] }`

- [ ] **Step 1: 失败测试**（jest）：GET 返回全部内建含禁用与豁免标记、分组齐全、未登记工具落 other；PUT 写入后 GET 反映；PUT 含豁免名被静默剔除；PUT 未知工具名报 400（防拼错静默无效——校验名字必须在内建清单中）
- [ ] **Step 2: 实现 + boot**　`pnpm build:server-agent && timeout 60 node apps/server-agent/dist/main.js` 无 DI 错，杀 7727
- [ ] **Step 3: 提交**　`feat(server-agent): 工具启停 REST——分组全量查询与禁用写入`

---

### Task 4: 编辑抽屉「工具」tab（依赖 Task 3）

**Files:**
- Create: `apps/web-agent/src/components/agent/tool-prefs-editor.tsx`
- Modify: `apps/web-agent/src/components/agent/agent-editor-sheet.tsx`（tab 联合类型加 `"tools"`、编辑态第四 tab、keep-mounted 面板）
- Modify: `apps/web-agent/src/rest/agents.ts`（GET/PUT 封装）+ `messages/*.json`

**Interfaces:** Consumes: Task 3 REST；UnifiedSheet 现有 tab 模式

- [ ] **Step 1: 实现**：分组折叠列表（默认全展开）——组头：组名 + 组级一键开关（组内全启/全禁，豁免项不计入组级判定）；行：工具名（`TOOL_LABELS` 友好名 + 等宽原名小字）+ `Switch`；豁免行 Switch disabled + Tooltip 提示「会话核心能力，不可禁用」；**变更即时保存**（PUT 全量 disabledTools，失败回滚开关态并内联报错）；加载态 Skeleton（暖底可见色调——[[flex-scroll-row-collapse]] 教训）；新建态不显示此 tab（无 agentId）
- [ ] **Step 2: i18n + 验证 + 提交**：组名 i18n（filesTerminal=文件与终端 / memory=记忆 / skills=技能 / im=消息 / drive=网盘 / schedule=定时任务 / subagent=子助手 / mcpManage=MCP 管理 / interaction=交互与产物 / other=其他）；`pnpm sync:locales -- --write` 填值 → `--check` missing=0；`pnpm format && pnpm typecheck`；commit `feat(web-agent): 编辑抽屉工具 tab——分组启停与豁免灰置`

---

### Task 5: 收尾验收

- [ ] **Step 1: 全量围栏**　`pnpm lint && pnpm typecheck && pnpm check && pnpm sync:locales -- --check && pnpm test && pnpm build`（基线对照惯例；web-agent build 后删 .next 留 out）
- [ ] **Step 2: 变异抽查 ×2**（先 grep 确认变异落地再看红绿，还原后同样确认）：①ToolRegistry 过滤条件取反 → 相关测试必须红；②F2 的无条件 Remove 改回条件 → 残留测试必须红
- [ ] **Step 3: 真机验收清单（交用户）**
  - 工具 tab：禁用 bash → 新一轮对话让助手跑命令，应答「没有该工具」而非执行；重新启用恢复
  - 豁免：todo_write/ask_question 灰置带提示；手工把 `"todo_write"` 写进 tools.json → 读取被剔除（对话中仍可用）
  - 组级开关：一键禁整个网盘组 → 组内全灰；组内单开一个 → 组开关半选/回弹逻辑符合直觉
  - 人机互通：tools.json 手工加 `"date"` → 工具 tab 显示禁用态
  - F2：删光某助手全部提示词文件 → **老会话**下一轮人格消失（不再残留）；卸载全部 MCP → 老会话下一轮 system:mcp 清单消失

---

## Self-Review 记录

- Spec §四覆盖：存储/生效/豁免/分组 → Task 1；REST/UI → Task 3/4；F2 → Task 2；验收 → Task 5。「写后无需 teardown」入 Global Constraints。
- 占位符：无 TBD；Task 3 的 listBuiltinsUnfiltered 依赖已在 Task 1 Interfaces 标注产出。
- 类型一致性：ToolPrefsSchema/PROTECTED_TOOLS/TOOL_GROUPS 定义与消费方（Service/REST/前端）命名一致；分组 key 与 i18n key 一一对应。
- 任务图：T1 与 T2 并行（tools/ vs graph/ 不重叠）→ T3 → T4；T5 收尾。
