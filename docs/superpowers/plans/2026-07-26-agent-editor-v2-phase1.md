# Agent 编辑器 v2 第一段（提示词文件化）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提示词文件化全链路：`<agentDir>/prompts/`（AGENT.md + *.md）→ 第五条系统消息 `system:prompts` 注入；丢弃 `agent.system_prompt` DB 列；编辑抽屉提示词 tab + 新建简化。

**Architecture:** 三个串行任务：①PromptFileService + REST（纯新增）→ ②注入切换 + 列丢弃（后端原子段，跨 entity/schema/runtime-context/context-builder）→ ③前端（提示词 tab + 新建拆向导）。收尾任务④做围栏/变异/真机清单。

**Tech Stack:** vitest（libs/agent）· jest（server-agent controller）· TypeORM 迁移（SQLite drop column）

**Spec:** `docs/superpowers/specs/2026-07-26-agent-editor-v2-design.md`（§三为本段唯一真相）

## Global Constraints

- 文件名校验逐字：`/^[\w.-]+\.md$/` + resolve 后仍在 prompts 目录内 + 大小写不敏感去重；`AGENT.md` 不可删不可改名
- 注入：AGENT.md 在首、其余按文件名字典序、`\n\n` 分隔、无文件名标头；总量 **64k 字符**截断 + 尾行「（提示词超长已截断）」；护栏具名常量
- `system:persona` 缩水为 MEMORY_GUIDE + `<memory>` + LLMUSE_GUIDE（agentSystemPrompt 段删除）
- libs/agent：vitest、禁 HTTP/TypeORM；tests/unit 不在 typecheck 范围——**改构造器签名必跑全量 vitest**（[[mcp-self-management]] 坑）
- 改 DI/entity 必须真 boot（`timeout 60 node dist/main.js`，验完杀 7727）
- 中文注释；中文 conventional commits + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>；每任务 `pnpm format`
- 工作分支 `feat/agent-editor-v2`（已建，spec 已在其上）

---

### Task 1: PromptFileService + REST（纯新增，TDD）

**Files:**
- Modify: `libs/agent/src/config/meshbot-config.service.ts`（`getPromptsDir()`，对照 `getSkillsDir()` :92 的写法：`<agentDir>/prompts`，mkdir 惰性）
- Create: `libs/agent/src/prompts/prompt-file.service.ts`（注意：账号级 `libs/agent/src/prompt/`（单数）是另一套兜底机制，**别混**；本服务用复数目录名 `prompts/`）
- Modify: `libs/agent/src/agent.module.ts`（provider 注册）+ `libs/agent/src/index.ts`（导出）
- Modify: `apps/server-agent/src/controllers/agent.controller.ts`（4 个端点）
- Modify: `libs/types-agent/src/agent.ts`（`PromptFileMetaSchema` = `{ file, size, mtime }`；`PromptFileBodySchema` = `{ content: z.string().max(200_000) }`）
- Test: `libs/agent/src/prompts/prompt-file.service.spec.ts`（vitest）

**Interfaces:**
- Produces: `PromptFileService.list(): PromptFileMeta[]`（AGENT.md 恒首位，物理不存在时也返回 `{file:"AGENT.md",size:0,mtime:null}` 占位）/ `read(file): string`（不存在返 ""）/ `write(file, content): void` / `remove(file): void`（AGENT.md 抛错）；全部要求 Agent ALS
- Produces: REST `GET /api/agents/:id/prompts`、`GET/PUT/DELETE /api/agents/:id/prompts/:file`（controller 内 `agentCtx.run(id, ...)` 包裹，对照 getMcp/putMcp 的现有写法；DELETE AGENT.md → 400；文件名非法 → 400）

- [ ] **Step 1: 失败测试**（vitest，tmp 目录真实 fs，对照 mcp.service.spec 的风格）：文件名校验拒绝 `../x.md`、`a/b.md`、`x.txt`、空名；大小写去重（`Agent.md` 与 `AGENT.md` 视为同名）；AGENT.md 删除抛错；list 排序（AGENT.md 首位 + 其余字典序）；write→read 回读一致；不存在文件 read 返 ""
- [ ] **Step 2: 实现**（校验函数导出为纯函数 `isValidPromptFileName(name)` 便于测试；`PROMPT_FILE_MAIN = "AGENT.md"` 常量导出——Task 2/3 消费）
- [ ] **Step 3: controller 端点 + jest**（`apps/server-agent` 现有 controller 测试形态；file 参数过 `isValidPromptFileName` 后再进 service）
- [ ] **Step 4: 验证 + 提交**　`pnpm --filter @meshbot/lib-agent test && pnpm format && pnpm typecheck`；commit `feat(agent): PromptFileService 与提示词文件 REST——prompts 目录 CRUD`

---

### Task 2: 注入切换 + DB 列丢弃（后端原子段，依赖 Task 1）

**Files:**
- Modify: `libs/agent/src/graph/context-builder.ts`（`buildPromptsBlock` 纯函数 + `buildPromptsMessage()` + `hasPrompts()`；`buildPersonaMessage` 删 agentSystemPrompt 段）
- Modify: `libs/agent/src/graph/graph-runner.service.ts`（两处对称注入第五条，条件 `hasPrompts()`——对照 system:mcp 刚做过的同款）
- Modify: `libs/agent/src/graph/runtime-context.port.ts`（删 `agentSystemPrompt` 字段）
- Modify: `apps/server-agent/src/runtime-context.module.ts:103-110`（删该字段供给）
- Modify: `apps/server-agent/src/entities/agent.entity.ts:25-26`（删列声明）
- Create: `apps/server-agent/src/migrations/1781600000000-DropAgentSystemPrompt.ts`（`ALTER TABLE "agent" DROP COLUMN "system_prompt"`；down 补回 `TEXT NOT NULL DEFAULT ''`）
- Modify: `libs/types-agent/src/agent.ts:25,41`（两处 systemPrompt 字段删除；grep 确认无第三处）
- Modify: `apps/server-agent/src/services/agent.service.ts:111,226,259`（create/duplicate/默认 agent 的 systemPrompt 赋值删除）
- Modify: `apps/server-agent/src/controllers/agent.controller.ts:38`（DTO 映射删字段）
- Test: `libs/agent/src/graph/context-builder.spec.ts`（增量）；受影响的既有测试全量对齐

**Interfaces:**
- Consumes: `PromptFileService.list()/read()`、`PROMPT_FILE_MAIN`
- Produces: `buildPromptsBlock(files: {name,content}[]): string`（含 64k 截断）；`system:prompts` 消息

- [ ] **Step 1: 失败测试**：buildPromptsBlock 三态（AGENT.md 在首/字典序/`\n\n` 分隔无标头；空列表由 hasPrompts 拦、不测块本身；64k 截断尾行逐字）；persona 不再含 agentSystemPrompt
- [ ] **Step 2: 实现注入**（ContextBuilder `@Optional` 注入 PromptFileService；graph-runner 两处对称——首次 push 段与刷新段）
- [ ] **Step 3: 列丢弃链**（按 Files 清单逐个删；删完全仓 grep `systemPrompt` 确认残余只剩 compactor/model-resolver 的无关同名参数与前端待 Task 3 处理项）
- [ ] **Step 4: 全量测试 + boot + 提交**

Run: `pnpm --filter @meshbot/lib-agent test`（**全量**，构造器可能变签名）
Run: `pnpm test`（jest 全量——agent.service/controller 相关用例需同步删字段断言）
Run: `pnpm build:server-agent && timeout 60 node apps/server-agent/dist/main.js`
Expected: 启动日志含迁移执行 + `Nest application successfully started`；完毕杀 7727。**再启动第二次**确认迁移幂等不再跑。
Commit: `feat(agent): system:prompts 第五条系统消息接管人格——丢弃 system_prompt DB 列`

---

### Task 3: 前端——提示词 tab + 新建简化（依赖 Task 2）

**Files:**
- Modify: `apps/web-agent/src/components/agent/agent-editor-sheet.tsx`（大改：拆向导/复制下拉/MCP 步骤；tab 联合类型加 `"prompts"`；systemPrompt 表单字段删除）
- Create: `apps/web-agent/src/components/agent/prompt-files-editor.tsx`（提示词 tab 内容组件）
- Modify: `apps/web-agent/src/rest/agents.ts`（4 个 prompts REST 封装）
- Modify: `apps/web-agent/messages/zh.json` / `en.json`

**Interfaces:**
- Consumes: Task 1 REST；`UnifiedSheet` 现有 headerTabs/footer/requestClose 模式

- [ ] **Step 1: 新建简化**：`wizardStep` 状态机整体删除（回到单一表单：name/avatar/description/defaultModel；`remoteEnabled` 仍仅编辑态）；「从现有 Agent 复制」下拉整块删除（第三段移去侧栏菜单，本段直接消失）；新建 footer = [取消] [创建(brand)]，创建成功直接关闭
- [ ] **Step 2: 提示词 tab**：`PromptFilesEditor`——左列文件列表（AGENT.md 置顶固定标「主文件」+ 新建输入（校验 `.md`）+ 非主文件行删除按钮带确认）+ 右区 textarea（等宽字体）+ 显式「保存」按钮（PUT 单文件）；切文件/关抽屉时未保存内容并入 requestClose 脏检测（`promptDirty` 状态并入现有 isDirty 判定）；加载态/错误态对照 McpEditor 现状
- [ ] **Step 3: i18n + 验证 + 提交**　`pnpm sync:locales -- --write` 补 stub 填值 → `-- --check` missing=0；`pnpm format && pnpm typecheck`；commit `feat(web-agent): 编辑抽屉提示词 tab 与新建单步化`

---

### Task 4: 收尾验收

- [ ] **Step 1: 全量围栏**　`pnpm lint && pnpm typecheck && pnpm check && pnpm sync:locales -- --check && pnpm test && pnpm build`（基线对照惯例）
- [ ] **Step 2: 变异抽查**　buildPromptsBlock 的「AGENT.md 在首」排序取反 → grep 确认落地 → 测试变红 → 还原绿
- [ ] **Step 3: 真机验收清单（交用户）**
  - 老 Agent 升级后正常启动对话（列已删无回归；人格暂空属预期——老数据不迁移）
  - 编辑抽屉建 AGENT.md 写人格 → 新一轮对话人格生效；再建第二个 md（如 `tone.md`）→ 追加语气生效；删除后失效
  - 新建 Agent：单步表单（无向导/无复制下拉/无 MCP 步骤），创建即关
  - 未保存提示词切文件/关抽屉 → 脏确认
  - 手工在 `<agentDir>/prompts/` 放 md 文件 → 编辑器列表可见（人机互通）

---

## Self-Review 记录

- Spec §三覆盖：存储→T1；注入+DB→T2；tab+新建→T3；验收→T4。缩水 persona、runtime-context 字段删除在 T2 原子完成（拆开会中间态编译错）。
- 占位符：无 TBD；T2 Step 3 的 grep 收尾给了预期残余清单。
- 类型一致性：`PROMPT_FILE_MAIN`/`isValidPromptFileName` T1 定义 T2/T3 消费；`PromptFileMetaSchema` T1 定义 T3 REST 封装消费。
