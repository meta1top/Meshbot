# Agent 修缮三件套（llmuse 联动 / 压缩位置漂移 / MCP 热加载）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三个已诊断项：①persona 的 LLMUSE IM 指引随工具禁用联动；②压缩不再吞掉稳定 id 系统消息（修位置漂移根因）；③MCP 写操作热生效（本轮即用）。

**Architecture:** 三任务并行（文件集互不重叠）：①libs/agent prompt+context-builder；②server-agent compactor；③libs/agent mcp+tools/builtins+前端文案。②按高风险档走（压缩不变量），③中-高（生命周期并发）。

**Spec:** 无独立 spec——三项均为既有审查/终审已诊断项，设计决策记录于各 Task 头部（本 plan 即设计真相）。

## Global Constraints

- libs/agent：vitest、禁 HTTP/TypeORM、改构造器签名必跑**全量** vitest；server-agent：jest
- ⚠️ mergeMessages reducer 铁律（[[agent-editor-v2]]）：同批 Remove+同 id add 会尾插；刷新稳定 id 消息用同 id 直接 push
- 压缩不变量（agent-arch）：消息序 `[system, summary, ...keep]`；split 不切断 tool_call/result 配对；per-session 锁
- 改 DI 真 boot（timeout 60 node dist/main.js，杀 7727）；变异抽查先 grep 落地再看红绿、**与并行测试进程互斥**（串行执行）
- 中文注释；中文 conventional commits + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>；每任务 `pnpm format`
- 工作分支 `feat/agent-polish`（已建）

---

### Task 1: llmuse IM 指引随工具禁用联动（低-中档）

**设计决策**：`LLMUSE_GUIDE` 拆两段——「`<llmuse>` 块说明」（恒注入，与工具无关）+「IM 工具指引」（按当前 Agent 禁用集**逐工具过滤**行；三个只读 IM 工具全禁时整段省略）。ContextBuilder `@Optional` 注入 ToolPrefsService（无它时不过滤，行为同现状）。

**Files:**
- Modify: `libs/agent/src/prompt/llmuse-guide.ts`（拆 `LLMUSE_BLOCK_INTRO` 常量 + `buildLlmuseGuide(disabled: ReadonlySet<string>): string` 工厂——纯函数便于测试；工具行清单具名常量 `LLMUSE_IM_TOOLS = ["im_unread_overview","im_read_conversation","im_list_members"]`）
- Modify: `libs/agent/src/graph/context-builder.ts`（buildPersonaMessage 改用工厂；@Optional 注入 ToolPrefsService——**又一次构造器签名变更，全量 vitest + tests/unit 对位**）
- Test: llmuse-guide 纯函数三态（全启/部分禁/全禁）+ context-builder persona 增量

- [ ] Step 1 失败测试 → Step 2 实现全绿（全量 vitest）→ Step 3 提交 `fix(agent): LLMUSE IM 指引随工具禁用联动——禁用的工具不再被 persona 教调用`

---

### Task 2: 压缩豁免稳定 id 系统消息（高档：TDD + 变异 + 复审重点）

**设计决策**：压缩工作集**先剔除 `id` 以 `system:` 为前缀的消息**（partition），它们既不进摘要也不进 removeIds——物理留在 checkpoint 原位（头部），天然满足 `[system..., summary, ...keep]`。修正 :166-168 的过时注释（「系统提示词无 id」假设已失效——五条稳定 id 系统消息会被吞进摘要并删除，下一轮同 id push 因旧 id 已删而尾插，这就是「压缩后系统消息位置漂移」的根因）。

**Files:**
- Modify: `apps/server-agent/src/services/context-compactor.service.ts`（工作集 partition；splitIdx/keep≥2/expandToToolBoundary 全部基于剔除后的 rest 计算；removeIds 仅 rest；serializeForSummary 输入仅 rest）
- Modify: `apps/server-agent/src/services/context-compactor.utils.ts`（若 partition 助手放这里）
- Test: `context-compactor.service.spec.ts` 增量（jest）

**关键用例**：含五条 system:* 头部消息的快照压缩后——①system 消息 id 全部仍在且**位置在 summary 之前**；②摘要 LLM 输入不含 system 内容；③removeIds 不含 system:*；④keep≥2 语义按 rest 计数（system 不占 keep 名额）；⑤纯 system+1 条 human 的短会话不触发压缩（rest 太少）；⑥tool 配对完整性回归不破

- [ ] Step 1 失败测试 → Step 2 实现全绿（jest 全量）→ Step 3 提交 `fix(server-agent): 压缩豁免稳定 id 系统消息——修压缩后系统消息尾插漂移根因`

---

### Task 3: MCP 写操作热生效（中-高档）

**设计决策**：`McpService.updateConfig` 落盘后由「teardown（下次 run 重建）」升级为「teardown + **立即 ensureAgent 重建**」（新私有方法 `reloadAgent` 封装，updateConfig 尾调）。supervisor 每步现算工具集（graph.builder:106 toolsProvider），下一步即见新工具——**本轮对话内热生效**。REST PUT 同路径自动获得热生效。文案联动：五个 mcp 工具返回值与编辑抽屉 MCP tab 说明从「下一轮对话生效」改为「已生效（新工具立即可用）」。

**并发风险（必须处理并测试）**：运行中 run 持有旧 entry 的 refCount，`teardownAgent` 删 map 后 `release()` 若按 key 查 map 会错误地减**新 entry** 的计数（负数/误回收）。修法：acquire/release 改按 **entry 对象身份**（acquire 返回 entry 引用或带代际 token，release 校验身份不匹配则 no-op 并 warn）；旧 entry 的 client close 延迟到其 refCount 归零（teardown 时 refCount>0 → 移出 map 但挂入 `retired` 列表，最后一个 release 时 close）——或证明现实现已安全（读源码后按实况，报告写清）。

**Files:**
- Modify: `libs/agent/src/mcp/mcp.service.ts`（reloadAgent + acquire/release 身份化 + retired 生命周期）
- Modify: `libs/agent/src/tools/builtins/mcp-*.tool.ts` ×5（返回文案）+ description 里「下一轮」措辞
- Modify: `apps/web-agent/messages/*.json` + `mcp-editor.tsx` 说明文案（「保存后下次对话生效」→「保存即生效」）
- Modify: `libs/agent/src/graph/context-builder.ts` 无需动（system:mcp 下一轮刷新可接受——agent 自己刚操作完，本轮无需靠清单感知；在 mcp_list 描述里注明清单实时）
- Test: vitest——updateConfig 后 perAgent 立即有新运行态；并发场景（mock client）：run 持旧 entry 期间 teardown+ensure，旧 entry release 不影响新 entry 计数、旧 client 在归零后 close

- [ ] Step 1 失败测试 → Step 2 实现全绿（全量 vitest）→ Step 3 boot（`pnpm build:server-agent && timeout 60 node dist/main.js`，杀 7727）→ Step 4 提交 `feat(agent): MCP 写操作热生效——落盘即重建运行态，本轮对话即可用`

---

### Task 4: 收尾验收

- [ ] Step 1 全量围栏（惯例六件套；web-agent build 后删 .next 留 out）
- [ ] Step 2 变异抽查 ×2（**串行，避免污染并行测试**）：①compactor 的 system:* 剔除条件取反 → 用例红；②reloadAgent 调用注释掉 → 热生效用例红。两头 grep 实证
- [ ] Step 3 真机验收清单（交用户）
  - ①禁用 IM 组 → 新一轮问助手「你能读频道消息吗」——persona 不再教它调 IM 工具（回答应不再提这三个工具）；启用恢复
  - ②长对话触发压缩（或手动灌长上下文）→ 压缩后继续对话正常、人格/技能/MCP 清单都还在且行为正常（此前压缩后这些会尾插错位）
  - ③对话中让助手装一个 MCP → 确认后**同一轮内**它就能调用新工具（不用开新对话）；编辑抽屉保存 MCP 配置 → 立即生效；mcp_disable 同轮生效
  - 回归：MCP 装/卸/启/禁的既有确认卡与清单行为不变

---

## Self-Review 记录

- 三项设计决策均落在各 Task 头部（本 plan 即真相）；②的根因链（稳定 id → 吞进摘要 → 同 id push 尾插）与 reducer 铁律记忆一致。
- 类型一致性：`buildLlmuseGuide(disabled)` 签名 T1 内闭环；`reloadAgent` T3 内闭环；无跨任务接口。
- 任务图：T1/T2/T3 三路并行（llmuse+context-builder / compactor / mcp+builtins+前端文案，文件集两两不重叠）→ T4 收尾。
