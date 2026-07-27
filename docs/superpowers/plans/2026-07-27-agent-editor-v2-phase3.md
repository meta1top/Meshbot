# Agent 编辑器 v2 第三段（技能 tab + MCP CodeMirror）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 编辑抽屉补齐第五 tab「技能」（已装列表 + 卸载 + 简版市场安装）+ MCP tab 升级 CodeMirror JSON 编辑器（高亮/行号/实时校验定位/一键格式化）。

**Architecture:** 技能 tab 全量复用 /skills 页的 REST 封装与卡片组件（窄容器适配）；CodeMirror 用 `@uiw/react-codemirror` 包装层 + `@codemirror/lang-json` + `@codemirror/lint`，替换 McpEditor 内部 textarea、**受控 props 不变**（value/onChange/error/loading/loadFailed），保存语义不动。两任务并行。

**Tech Stack:** @uiw/react-codemirror（新依赖，仅 web-agent）· 既有 /api/skills REST

**Spec:** `docs/superpowers/specs/2026-07-26-agent-editor-v2-design.md` §五

## Global Constraints

- 编辑抽屉 tab 联合类型加 `"skills"`（第五 tab，排序：基本信息/提示词/技能/MCP/工具）；keep-mounted 面板同款；新建态不显示；**面板外壳必须 `flex flex-col`**（工具 tab 刚踩过 block 外壳裁内容无滚动的坑）
- CodeMirror 主题双态：亮色贴暖米（背景透明或 `--background`）、暗色跟 `.dark`（用 CodeMirror 的 theme extension 按 `document.documentElement.classList.contains("dark")` 或 CSS 变量方案，选实现最稳的；不引第三方主题包）
- McpEditor 对外接口零变化（agent-editor-sheet 不需要动 MCP 相关接线）；JSON 校验仍以保存时 `mcpJsonSyntaxError` 为准，CodeMirror lint 是**编辑期增强**不替代
- 技能安装/卸载即时生效（技能本就热加载——skill_load 现读盘），不需要「下一轮生效」文案；卸载走 ConfirmDialog
- 圆角档位类；Skeleton 暖底可见色调；i18n zh/en 齐禁裸字符串；中文注释；中文 conventional commits + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>；每任务 `pnpm format`
- 工作分支 `feat/agent-editor-v2-phase3`（已建）

---

### Task 1: MCP tab CodeMirror 升级

**Files:**
- Modify: `apps/web-agent/package.json`（`pnpm --filter @meshbot/web-agent add @uiw/react-codemirror @codemirror/lang-json @codemirror/lint`）
- Modify: `apps/web-agent/src/components/agent/mcp-editor.tsx`（textarea → CodeMirror；新增格式化按钮）
- Modify: `apps/web-agent/messages/*.json`（格式化按钮/ lint 提示相关 key）

**Interfaces:** 对外 props 不变（value/onChange/error/loading/loadFailed + 现有 labels）

- [ ] **Step 1: 装依赖 + 实现**
  - CodeMirror 配置：`json()` 语言 + `linter(jsonParseLinter())` + `lintGutter()`（错误行号槽标注）+ 行号 + `EditorView.lineWrapping`；高度约束沿用现容器（`min-h`/`flex-1` 链——外层已是 flex 语境，确认高度链完整能滚动）
  - 主题：basicSetup 禁用默认主题冲突项；用 `EditorView.theme` 写最小暖色适配（背景/选区/gutter 用 CSS 变量 `var(--background)`/`var(--border)` 等，天然跟随 .dark）
  - 「格式化」按钮：`JSON.parse` 成功 → `JSON.stringify(_, null, 2)` 回写 onChange；失败按钮置灰或点击后内联提示（复用现 error 展示位）
  - 保存路径回归：外部 error（保存时后端校验失败）仍在原位置展示，与 lint 行内标注并存不冲突
- [ ] **Step 2: 验证 + 提交**　`pnpm format && pnpm typecheck && pnpm sync:locales -- --check`；`pnpm build:web-agent` 确认 CodeMirror 不破构建（完毕删 .next 留 out）；commit `feat(web-agent): MCP 编辑器升级 CodeMirror——高亮/行号/实时校验/一键格式化`

---

### Task 2: 技能 tab（与 Task 1 并行，文件集不重叠）

**Files:**
- Create: `apps/web-agent/src/components/agent/skill-manager.tsx`
- Modify: `apps/web-agent/src/components/agent/agent-editor-sheet.tsx`（第五 tab 接线）
- Modify: `apps/web-agent/messages/*.json`

**Interfaces:**
- Consumes: `@/rest/skills` 既有封装（fetchMarket/fetchInstalled/installSkill/uninstallSkill——具体签名读文件）；`@/components/skills/` 的 `InstalledSkillCard`/`MarketSkillCard`/`market-skill-card-skeleton`（能直接复用就复用，窄容器放不下再做紧凑变体，**不改动原组件的既有消费方**）

- [ ] **Step 1: 实现 skill-manager**
  - 上段「已安装」：列表（技能名/描述/卸载按钮带 ConfirmDialog）；空态文案「尚未安装技能」+ 跳 /skills 链接
  - 下段「安装技能」：来源切换（system=MeshBot 市场 / clawhub）+ 搜索输入（防抖）+ 结果卡（含已装标记）+ 安装按钮（loading 态）；安装/卸载成功后已装列表即时刷新
  - 深度浏览入口：「前往技能页」链接（`/skills`）——发布/详情等重功能不搬
  - 加载态 Skeleton 暖底色调；错误内联 Alert
- [ ] **Step 2: 抽屉接线**　tab 联合类型 `"skills"`、SheetTabBar items（编辑态五 tab 顺序：基本信息/提示词/技能/MCP/工具）、keep-mounted 面板（**flex flex-col 外壳**）、新建态不显示
- [ ] **Step 3: i18n + 验证 + 提交**　`sync:locales -- --write` 填正式值 → `--check` missing=0；`pnpm format && pnpm typecheck`；commit `feat(web-agent): 编辑抽屉技能 tab——已装管理与简版市场安装`

---

### Task 3: 收尾验收

- [ ] **Step 1: 全量围栏**　`pnpm lint && pnpm typecheck && pnpm check && pnpm sync:locales -- --check && pnpm test && pnpm build`（web-agent build 后删 .next 留 out；lockfile 变更由 CI frozen-lockfile 校验）
- [ ] **Step 2: 真机验收清单（交用户）**
  - MCP tab：粘贴一段带语法错误的 JSON → 行内标注错误位置；修好 → 标注消失；点格式化 → 缩进归一；保存语义与此前一致（footer 无关，MCP 自己的保存按钮）；暗色主题下编辑器配色正常
  - 技能 tab：看到已装技能；市场搜索并安装一个 → 已装列表即时出现、对话中 skill_list 立即可见（热加载）；卸载带确认；「前往技能页」跳转正常
  - 五 tab 顺序与切换、keep-mounted 状态保持、滚动条正常（工具 tab 的坑不复发）

---

## Self-Review 记录

- Spec §五覆盖：技能 tab → Task 2；MCP CodeMirror → Task 1；下拉菜单/全量复制已在第一段拉前完成，不在本段。
- 占位符：REST 签名与卡片 props 指向真实文件由实施者读取（复用而非重写，无 TBD）。
- 一致性：五 tab 顺序在 Global Constraints 与 Task 2 一致；「面板外壳 flex」教训进 Global Constraints。
