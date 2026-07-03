# 技术债清理实施计划（dispatch_subagent 三阶段收尾）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清理 PR #8/#9/#10（dispatch_subagent 1a/1b/2 + 任务卡）三轮评审累积的技术债：sync-locales 根因修、前端小修包、统计口径、孤儿 GC、e2e 竞态审计、文档琐碎。

**Architecture:** 六个互相独立的小任务，无新功能语义（除孤儿 GC 与统计口径两个已拍板的产品决策）。范围决策均已用户确认（2026-07-03）：四个可选项全做。

**Tech Stack:** ts-morph（sync-locales 脚本）、React/Tailwind、NestJS/TypeORM、Jest/Vitest。

## Global Constraints

- 分支 `chore/debt-cleanup`（自 main def9824 切出——含 PR #8/#9/#10 全部内容）。不自动 push/开 PR（收尾由控制者处理；**合并需用户明确说「合并」**，CLI `gh pr merge` 在明确授权下可用）。
- `apps/web-agent/src/lib/*.ts` 纯逻辑模块**零 import 纪律**（根 jest node 环境、无 jsdom；jotai 纯 ESM 会炸；spec 只 import 被测模块）。web-agent 无组件测试基建，组件行为靠 typecheck/biome + 人工验收。
- i18n zh/en 键对称（pre-commit `sync-locales --check` 强制 missing/asymmetric=0）。**Task 1 完成前**新增嵌套命名空间键仍需顶层空占位 workaround；Task 1 完成后不再需要且既有占位全部删除。
- 围栏脚本（scripts/）改动必须有单测（CLAUDE.md 硬性要求）；公开方法中文 JSDoc；Biome `if` 前一行不放注释；单表读写不挂 @Transactional；unscoped 查询带 `// scope-check: allow-unscoped`。
- 中文 conventional commits + 结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- **只跑本任务相关测试**；全量 typecheck/根 jest/围栏/boot 留 Task 6。判回归对比 merge-base（main），报错文本引用分支新增符号=分支回归。
- 基线：根 jest 全绿+1 skip（session.e2e retry 用例既有 `it.skip`）；libs/agent vitest unit 目录 5 个预存在失败（supervisor.node 一批）+ dist 陈旧噪音，套件级共 9 失败——只看新增；typecheck 26/26。
- 环境：dev 库在仓库根 `.meshbot/`（main.db，勿删改目录）；server-agent 端口自检（看启动日志/.meshbot/agent.port，不固定）；`libs/agent`/`libs/types-agent` 的 dist 是 gitignored 持久产物，起 dev/依赖它的验证前先 `pnpm --filter <pkg> build` 确认反映 HEAD（历史踩坑两次）。

---

## Task 1: sync-locales 嵌套命名空间根因修 + 顶层占位键清理

**Files:** Modify `scripts/sync-locales.ts`、`apps/web-agent/messages/zh.json`、`en.json`；Test：脚本核心解析逻辑单测（查 scripts/ 既有 spec 模式；若无先例则新建 `scripts/sync-locales.spec.ts` 由根 jest 拾取——注意根 jest roots 含 `<rootDir>/scripts`）。

**根因（已核实）：** 脚本用 ts-morph 收集 `useTranslations("ns")` 首参与 `t("key")` 字面量为**互不关联**的 used keys（~103-122 行），从不拼接 → 嵌套命名空间下 `t("bareKey")` 按裸键查顶层必报 missing。历史 workaround：顶层空串占位键（`rowTitle`/`rename`/`fallbackTitle`/`stop`/P2 的 8 个/`presentFailed` 等，zh/en 各一份）。

**修法：** 对调用表达式为标识符（`t("x")`/`s("y")`）的情况，用 ts-morph 解析该标识符的声明初始化器：若是 `useTranslations("ns")` 调用则收集 `ns.x`；解析不到（透传/动态）保持旧行为收裸键。`useTranslations("ns")` 首参本身继续按 namespace 前缀收集（既有 prefix 命中逻辑保留）。服务端 `i18n.translate` 路径不动。核心「标识符→命名空间解析」提为可测纯函数/独立步骤。

**清理：** 修完删除 zh/en 全部「顶层 value===空串 且 同名键存在于某嵌套命名空间」的占位键。

**验收：** 单测覆盖（多变量多命名空间/透传兜底/翻译服务端路径不受影响）；`npx tsx scripts/sync-locales.ts -- --check` 在删光占位键后 missing=0 asymmetric=0；`pnpm jest scripts` 绿。

---

## Task 2: web-agent 小修包（任务卡终局态/翻页水合/安全截断/暗色语义色）

**Files:** Modify `apps/web-agent/src/lib/subagent-card.ts`(+spec)、`apps/web-agent/src/hooks/use-session-stream.ts`、`apps/web-agent/src/components/session/subagent-card.tsx`。

1. **未认领但已终局的卡永显「启动中」**（1b 终审 Minor#1）：dispatch 在排队期 abort/父缺失时返回 `{subSessionId:"", status:"error"|"aborted", ...}`——`resolveSubSessionId` 得 null → 卡永远 starting（脉动）。修法：新纯函数（或扩展）`resolveUnclaimedStatus(tool)`：`subSessionId===null && tool.result 可解析出 status error|aborted` → 返回该终态；组件的 status 计算改为 `subSessionId===null ? (resolveUnclaimedStatus(tool) ?? "starting") : resolveSubagentStatus(tool, sub.running)`。终局未认领卡无嵌套流/无停止（现状条件天然成立）。TDD：spec 补 error/aborted/无结果三分支。
2. **loadMoreHistory 丢字段**（1b 终审 Minor#2，全工具通用）：`use-session-stream.ts` 的 loadMore 映射只带 id/role/content/reasoning——丢 `toolCalls`（含 `subSessionId` 透传！）/`feedback`/`metadata`。修法：把首屏 fetch 的映射（~177-199 行，含 toolCalls 完整字段与 subSessionId 展开）提取为共享函数 `historyMessageToTimeline(m)`，两处调用。纯函数放哪：映射引用 TimelineMessage 类型（组件模块）——放 hook 文件内即可（hook 本身不被根 jest 测），或类型收窄后入 lib；**不强求单测**（无 jsdom），typecheck+人工翻页验收。
3. **code-point 安全截断**（A-M1）：`subagent-card.ts` 的 `summarizeArgs`/`firstLineOf`/`deriveLiveAction` 正文截断改用 `Array.from(str).slice(0,n).join("")` 语义（代理对/emoji 不切半）；提公共 `truncate(str, max)` helper；spec 补 emoji 用例（如 "🎉".repeat(50) 截断后无 U+FFFD/半代理对）。
4. **SubagentStatus JSDoc 归属**：类型别名自己的 JSDoc 与 `resolveSubagentStatus` 的分开写。
5. **暗色语义色 token 化**（A-M3）：`subagent-card.tsx` 的硬编码 `#3D8A4E`（三处：CHIP/GLYPH/结果行箭头）换 Tailwind 语义绿 + dark 变体（如 `text-emerald-700 dark:text-emerald-400`、`bg-emerald-600`——与项目暗色 token 体系核对，若 design 包有 success token 优先用）；字面 `✓ `/`✗ ` 换 lucide `Check`/`X` 小图标（h-3 w-3）。人工暗色一瞥留 Task 6。

---

## Task 3: server-agent 清理 + 统计口径 + 孤儿前台 GC + 测试补齐

**Files:** Modify `apps/server-agent/src/services/session.service.ts`(+spec)、`session-message.service.ts`(+spec)、`dispatch-subagent.service.ts`(+spec)。

1. **删 `SessionService.hasFailedPending`**（P2 终审 M2：已被 `readTerminalState` 的 `listActivePending` 取代）+ 删其 spec 用例；grep 确认无其他消费方。
2. **统计排除 subagent**（1b 终审 M1，产品决策已确认）：`countCreatedSince` 加 `qb.andWhere("s.kind != 'subagent'")`（quick 保持既有计入行为，最小语义变化）；`activitySince` 的 `base()` 加 `qb.andWhere("m.session_id NOT IN (SELECT id FROM sessions WHERE kind = 'subagent')")`（雪花 id 全局唯一，子查询不必带账号 scope；若 scope 围栏对裸子查询报警按其注释规范处理）。真库测试：造 user+subagent 会话/消息，断言计数与热力图排除子会话。
3. **孤儿前台子会话 GC**（用户拍板语义：**标记了结，不重跑**——父上下文已死无人消费结果）：
   - `SessionService` 新增 unscoped 扫描（带 `// scope-check: allow-unscoped`）：`kind='subagent' AND background=0 AND EXISTS 活跃 pending(status IN pending/processing)`，返回 `{id, cloudUserId}`。
   - `DispatchSubagentService.onApplicationBootstrap` 追加（在既有 background=1 恢复扫描之后）：每行 `account.run` 内 `listActivePending(id)` → `markFailed(全部活跃 ids)` + `setStatus(id, "idle")`，log 一行。不过信号量（无 run）。
   - 测试：boot 两类扫描共存（后台恢复照旧 settle、前台孤儿只标记）；无孤儿零动作。
4. **settle/boot 测试补齐**（P2 终审 acceptable-defer 转正）：`updateToolResult` 返回 0→重试分支（把 1s 延迟提为可注入/常量以便测试）；`appendMessage` 第一次抛第二次成功 → 正常走完 kick/重写/settled/置0；播报文案断言补「失败」「已中止」两态；boot 恢复同账号多行的信号量排队（同一账号 2 行 deferred settle，断言串行获槽）。

---

## Task 4: libs/agent + types-agent 文档琐碎与 smoke test（1a 遗留）

**Files:** Modify `libs/agent/src/graph/graph.builder.ts`、`graph-runner.service.ts`、`libs/agent/src/tools/builtins/dispatch-subagent.tool.ts`、`libs/types-agent/src/`（新 spec）。

1. `buildSupervisorGraph` JSDoc 补 `@param excludeToolNames`。
2. `pickGraph` 处 msgIdMap 相关 JSDoc 归位（1a Task5 评审注记：位置易误读）。
3. dispatch tool 的 `z.input` 类型选择补一句注释（为何用 input 而非 infer：兼容 ZodDefault 入参）。
4. `RunSubagentSpawnedEvent` 补编译期 smoke test（照 `subagent-settled.spec.ts` 同款：常量名 + payload 形状），文件 `libs/types-agent/src/subagent-spawned.spec.ts`。
纯文档+测试，无行为变化；`pnpm jest libs/types-agent` + libs/agent typecheck 即可。

---

## Task 5: server-main e2e WS 竞态审计（范围已按实证收窄）

**实证更正（2026-07-03）：** im-flow 的 WS 用例**已有**「周期性重发直到收到」重试（`im-flow.spec.ts` ~348 行注释原文），旧待办实际已落地；本周 CI 的 im-flow 5 连挂是 beforeAll 的 CREATE EXTENSION 竞态殃及全套件（已由 test-db.ts advisory lock 真修）。

**任务：** 审计其余 server-main e2e 套件（`im-multipod.spec.ts`、`im-private-channel.spec.ts`、`ws-health.spec.ts` 等）的 WS 收发用例：凡「emit 一次 + waitForEvent 等待对端」且依赖对端异步 join 房间的，补齐 im-flow 同款重发重试模式（提取公共 helper 到 test 工具文件更佳）。本地无 PG 时做静态审计+改造，CI 为验证面。产出里列出「审计了哪些用例、改了哪些、为何其余不需要」。

---

## Task 6: 集成验证

1. `pnpm typecheck && pnpm test`（基线全绿+1 skip）；`pnpm --filter @meshbot/agent test` 对照基线。
2. `pnpm check && pnpm format && pnpm lint`。
3. 隔离 boot（无新迁移，保险）：`MESHBOT_HOME=$(mktemp -d)` 起 server-agent，确认孤儿 GC 空库零动作、health 200。
4. 人工验收清单（交用户）：暗色主题任务卡语义色对比度；工具卡上翻页还原（含 dispatch 卡认领）；伪造一个终局未认领场景可选（信号量占满时停止父 run）。
5. 收尾提交（如有格式化残留）。

---

## Self-Review（计划自审）

- 范围=已确认决策：必做包 7 项分布于 T1-T4；四个可选项全做（T2.5 暗色、T3.2 统计、T3.3 GC、T5 竞态审计）。孤儿 GC 语义（标记不重跑）、统计口径（只排 subagent、quick 不动）均已拍板并写明。
- 无占位符；「以文件实际为准」限于既有装配/scope 围栏注释规范等现场核对点。
- 各任务独立可测可评审；T1 与其余无依赖但**建议先做**（做完后 T2 若新增 i18n 键不再需要占位 workaround）。
