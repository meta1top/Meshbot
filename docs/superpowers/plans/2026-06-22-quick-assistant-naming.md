# 实施计划：随手问命名（默认名 / 改名 / 上下文注入 / 改名 tool）

设计：`docs/superpowers/specs/2026-06-22-quick-assistant-naming-design.md`

范围：本计划覆盖 item 3-5（item 1-2 已在 `feat(web-agent): 随手问头部对齐会话头高度 + 去副标题` 完成）。
单个账号级全局随手问名，存 `Setting`（键 `quick_assistant_name`，默认 "随手问"）。

依赖方向：libs/types-agent（schema）→ libs/agent（tool/prompt）；server-agent 实现端口与 REST；web-agent 读写名字。

---

## Task 1 — Setting 存储 + 读写（server-agent）

- `SettingService`：加 `getQuickAssistantName()`（缺省返回 "随手问"）与 `setQuickAssistantName(name)`（单表 upsert，校验非空、长度上限，如 ≤ 20）。
- 单测：默认值；set 后 get 返回新值。
- 围栏：account scope（`quick_assistant_name` 走账号作用域）；单表无需 `@Transactional`。

验收：`pnpm test`（server-agent SettingService）绿。

## Task 2 — REST 端点（server-agent，给 UI 用）

- GET 当前名、PATCH 新名。复用 `setting.controller` 通用端点或新增瘦 controller `/api/quick-assistant/name`（业务下沉 SettingService）。
- DTO 走共享 zod（libs/types-agent），Swagger 声明输入输出。
- 单测/e2e：GET 默认、PATCH 改名、非法名 400。

验收：端点可读写；typecheck 通过。

## Task 3 — runtime-context 暴露名字（server-agent → libs/agent）

- 在 `runtime-context.port`（libs/agent）的账号级上下文接口加 `quickAssistantName`。
- server-agent 的 RuntimeContext 实现从 SettingService 填充该字段。

验收：libs/agent 能从 runtime-context 读到名字；typecheck 通过。

## Task 4 — PromptService 注入（libs/agent，item 4）

- 构建系统提示时：`session.kind === "quick"` → 注入名字段（如「你的名字是『<name>』，由用户随手唤起，不绑定任何具体对话」）；非 quick 不注入。
- 单测：quick 注入且含名字；user 不注入。

验收：libs/agent 单测绿（含上述两用例）。

## Task 5 — 改名 tool + 端口 + 实时事件（libs/agent + server-agent，item 5）

- libs/agent：新增 `tools/quick-assistant.port.ts`（`QUICK_ASSISTANT_PORT` symbol + `{ rename(name: string): Promise<void> }`）与 `tools/builtins/rename-quick-assistant.tool.ts`（仿 skill-install.tool 范式，`@Inject(QUICK_ASSISTANT_PORT)`），参数 zod：新名字非空 + 长度上限。
- server-agent：模块绑定端口（仿 `skill.module` 的 `SKILL_TOOLS_PORT` useFactory），`rename` → `QuickAssistantService.setName`。
- **实时事件链（socket，core 诉求）**：改名集中在 server-agent 的 `QuickAssistantService.setName(name)` = `SettingService.set(quick_assistant_name)` + `eventEmitter.emit(QUICK_ASSISTANT_EVENTS.renamed, { name })`（在账号上下文内 emit，路由到 acct 房间）。
  - types-agent：新增 `quick-assistant.events.ts`：`QUICK_ASSISTANT_EVENTS = { renamed: "quick_assistant.renamed" }` + `QuickAssistantRenamedEventSchema { name }`（仿 schedule.events.ts）。
  - server-agent `EventsGateway`：加 `@OnEvent(QUICK_ASSISTANT_EVENTS.renamed)` → `emitEnvelope(type, payload)`（仿 onScheduleFired）。
  - REST PATCH（Task 2）也走 `QuickAssistantService.setName` → 同样 emit，使多窗口/本窗口一致实时更新。
- 工具可见性：quick 会话可用（或全局，按 graph 工具装配约定）。
- 单测：tool 调用 port.rename 透传名字（仿 skill-tools.spec）；QuickAssistantService.setName 写 Setting + emit。

验收：libs/agent 单测绿；server-agent 端口实现 + emit typecheck/单测通过；agent 改名后浏览器经 ws 收到 renamed 事件。

## Task 6 — dock 显示名字 + 内联改名（web-agent，item 3）

- 新增 setting query/atom 读取随手问名（默认回退 "随手问"）。
- AssistantDock 标题由 `t("title")` 改为显示该名字；点标题进入 input 编辑，回车/失焦 PATCH 保存并更新 atom。
- tool 改名后若 dock 打开，经事件/重取刷新标题。
- 文案走 next-intl（编辑态 placeholder/aria 等），zh/en 同步。

验收：目视——dock 显示名字、改名持久化、刷新后保持、tool 改名标题更新。

## Task 7 — 收尾

- `pnpm typecheck` / `pnpm lint` / `pnpm check` 全绿；`sync-locales --check` 通过。
- 目视回归：dock 头与会话头同高、无副标题、名字链路通。
- 提交（中文 conventional commits，可按 存储/REST/上下文/tool/前端 拆分）。

---

## 备注 / 风险

- runtime-context 注入路径需确认现有 `runtime-context.port` 已承载账号级运行时数据（settings 类）；若尚无该通道，Task 3 需先打通（参考现有 settings 注入方式）。
- 改名后 dock 实时刷新：优先复用既有 ws/events 事件总线（useGlobalEvents）；否则 dock 打开时重取。
- item 1-2 已完成，无需重做。
