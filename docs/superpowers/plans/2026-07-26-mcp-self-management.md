# MCP 感知注入与自管理工具集 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 注入 `system:mcp` 第四条系统消息（格式说明 + server 清单），并交付 `mcp_list/install/uninstall/enable/disable` 五个内建工具（install 走 HITL 确认卡）。

**Architecture:** schema 加 `enabled`；写路径收敛为 `McpService.updateConfig()`（controller 与工具共用）；install 确认经 `MCP_CONFIRM_PORT` 到 server-agent 挂现有 ConfirmationService 单例；前端新特化确认卡。生效时机沿用「落盘→teardownAgent→下次 run 重建」。

**Tech Stack:** Zod · LangGraph（注入点）· vitest（libs/agent）· jest（server-agent/web-common）

**Spec:** `docs/superpowers/specs/2026-07-26-mcp-self-management-design.md`（内容格式、决策表逐字为准）

## Global Constraints

- `libs/agent` 纪律：测试用 **vitest**（jest.config 排除该库）；禁 HTTP/TypeORM/Controller 装饰器；纯逻辑写工厂函数
- ConfirmationService **单例命门**：server-agent 侧新 module 必须 `useExisting` 复用 `im-send.module.ts` 的 provide，严禁重复 provide
- `system:mcp` 内容格式照 spec §三 的块逐字（`<mcp>` 包裹；引导文案两处）
- 确认卡对 `env`/`headers` **只展示 key 不展示值**（可能含密钥）
- 所有写操作工具的返回文案必须含「下一轮对话生效」语义
- 改 DI/provider 必须真 boot 验证（`timeout 60 node dist/main.js`，验完杀 7727）
- 中文注释 / 中文 conventional commits + Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>；改完跑 `pnpm format`
- 工作分支 `feat/mcp-self-management`（已建，spec 已在其上）

---

### Task 1: schema enabled + McpService 写路径收敛（TDD vitest）

**Files:**
- Modify: `libs/agent/src/mcp/mcp.schema.ts`
- Modify: `libs/agent/src/mcp/mcp.service.ts`（updateConfig / getLoadedToolNames / mapServersToLangchainShape 过滤）
- Modify: `apps/server-agent/src/controllers/agent.controller.ts:135-163`（PUT 改调 updateConfig）
- Test: `libs/agent/src/mcp/mcp.schema.spec.ts`（若无则建）、`libs/agent/src/mcp/mcp.service.spec.ts`（增量用例）

**Interfaces:**
- Produces: `McpServerConfigSchema` 各分支含 `enabled?: boolean`；`McpService.updateConfig(mutator: (config: McpConfig) => McpConfig): Promise<void>`（校验→落盘→teardown 当前 ALS 账号+Agent）；`McpService.getLoadedToolNames(cloudUserId, agentId): ReadonlySet<string> | null`

- [ ] **Step 1: 失败测试**（vitest）：`enabled` 缺省放行/显式 false 通过校验；`mapServersToLangchainShape` 过滤 `enabled===false`（导出该函数或经 service 间接断言）；`updateConfig` mutator 产物校验失败时不落盘不 teardown、成功时先写盘再 teardown（mock fs 与 teardown spy 断言次序）
- [ ] **Step 2: 实现**

schema 两分支各加：

```ts
  /** 是否启用（缺省 true）。禁用 = 配置保留但不建连接。 */
  enabled: z.boolean().optional(),
```

`mapServersToLangchainShape` 开头过滤：`if (cfg.enabled === false) continue;`（保留注释：清单注入仍包含禁用项）。

`McpService` 新增（放 loadConfig 附近）：

```ts
  /**
   * 读-改-写 mcp.json（单一写入真相：REST PUT 与自管理工具共用）。
   * mutator 拿到当前配置（无文件时为空配置）返回新配置；校验失败抛错不落盘；
   * 成功落盘后失效当前 Agent 运行态（下次 run 重建）。须在账号+Agent ALS 内调用。
   */
  async updateConfig(mutator: (config: McpConfig) => McpConfig): Promise<void> {
    const current = this.loadConfig() ?? { mcpServers: {} };
    const next = McpConfigSchema.parse(mutator(structuredClone(current)));
    const path = this.config.getMcpConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await this.teardownAgent(this.account.getOrThrow(), this.agentCtx.getOrThrow());
  }

  /** 该 Agent 本轮运行态已加载的 MCP 工具名（null = 尚无运行态/未加载）。 */
  getLoadedToolNames(cloudUserId: string, agentId: string): ReadonlySet<string> | null {
    return this.perAgent.get(`${cloudUserId}:${agentId}`)?.names ?? null;
  }
```

（`account`/`agentCtx` 若 McpService 未注入则补注入——对照现有构造器；`dirname`/`mkdirSync` 自 `node:fs`/`node:path`。）

PUT controller 的 parse+写盘+teardown 三段替换为：

```ts
    await this.agentCtx.run(id, () =>
      this.mcp.updateConfig(() => result.data),
    );
```

（JSON.parse 与 safeParse 的 400 报错保留在 controller——HTTP 语义留在 HTTP 层。）

- [ ] **Step 3: 跑绿 + 提交**　`pnpm --filter @meshbot/lib-agent test -- mcp && pnpm format && pnpm typecheck`；commit `feat(agent): MCP schema 加 enabled 并收敛写路径为 McpService.updateConfig`

---

### Task 2: system:mcp 注入（依赖 Task 1 的 getLoadedToolNames；与 Task 3 文件集不重叠可并行）

**Files:**
- Modify: `libs/agent/src/graph/context-builder.ts`（buildMcpBlock 纯函数 + buildMcpMessage）
- Modify: `libs/agent/src/graph/graph-runner.service.ts:151-154,197-200`（注入 + 每轮刷新，两处对称）
- Test: `libs/agent/src/graph/context-builder.spec.ts`（若无则建，vitest）

**Interfaces:**
- Consumes: `McpService.loadConfig()` / `getLoadedToolNames()`（@Optional 注入，无 McpService 时整条消息省略——对齐 skills 的 hasSkills 范式，新增 `hasMcp()`）
- Produces: `buildMcpBlock(servers, loadedNames)` 纯函数；`ContextBuilder.buildMcpMessage(): SystemMessage`（id `system:mcp`）；`ContextBuilder.hasMcp(): boolean`

- [ ] **Step 1: 失败测试**：`buildMcpBlock` 三态——无配置（引导文案）、有配置含禁用项（标「已禁用」）、运行态未加载（标「未加载」而非 0 个工具）；每行格式 `- <name>（stdio|sse|streamable_http，已启用/已禁用，…）`
- [ ] **Step 2: 实现**：内容格式逐字照 spec §三；协议标签 stdio 用 `isStdioServer` 判别、http 取 `transport ?? "streamable_http"`；工具数 = `loadedNames` 里前缀 `mcp__<name>__` 的计数。`graph-runner` 两处注入点（首次 inputMessages.push 与刷新段的 Remove+重建）对称加第四条，条件 `contextBuilder.hasMcp()`
- [ ] **Step 3: 跑绿 + 提交**　commit `feat(agent): 注入 system:mcp——MCP 工具格式说明与 server 清单`

---

### Task 3: 五个工具 + MCP_CONFIRM_PORT + server-agent 接线（依赖 Task 1；与 Task 2 并行）

**Files:**
- Create: `libs/agent/src/tools/mcp-confirm.port.ts`
- Create: `libs/agent/src/tools/builtins/mcp-list.tool.ts` / `mcp-install.tool.ts` / `mcp-uninstall.tool.ts` / `mcp-enable.tool.ts` / `mcp-disable.tool.ts`
- Modify: `libs/agent/src/agent.module.ts`（providers 注册五个工具）
- Create: `apps/server-agent/src/mcp-confirm.module.ts`（@Global，绑 MCP_CONFIRM_PORT 实现，ConfirmationService **useExisting**）
- Modify: `apps/server-agent/src/app.module.ts`（imports 新 module，对照 ask-question.module 的挂法）
- Test: `libs/agent/src/tools/builtins/mcp-tools.spec.ts`（vitest，mock McpService + port）

**Interfaces:**
- Consumes: `McpService.updateConfig/loadConfig/getLoadedToolNames`、`ConfirmationService.waitForDecision`（key = `${cloudUserId}:${sessionId}:${toolCallId}`，对照 ImSendService）
- Produces: 五个 `@Tool()` 类；`MCP_CONFIRM_PORT: Symbol` + `McpConfirmPort { confirmInstall(params, signal): Promise<"confirmed"|"cancelled"|"timeout"|"interrupted"> }`

- [ ] **Step 1: 失败测试**：install 确认 confirmed 才 updateConfig、cancelled/timeout 不写且返回对应终态文案；install 重名报错；uninstall 不存在报错；enable/disable 幂等（已是目标态返回成功）；所有写操作返回文案含「下一轮对话生效」
- [ ] **Step 2: 端口**（对照 im-send.port.ts 注释风格）：

```ts
export const MCP_CONFIRM_PORT = Symbol("MCP_CONFIRM_PORT");
/** mcp_install 的 HITL 确认端口：server-agent 实现弹卡等待用户决定。fail-safe：超时/中断视为不安装。 */
export interface McpConfirmPort {
  confirmInstall(
    params: { sessionId: string; toolCallId: string; name: string; server: McpServerConfig },
    signal: AbortSignal,
  ): Promise<"confirmed" | "cancelled" | "timeout" | "interrupted">;
}
```

- [ ] **Step 3: 工具类**（`@Injectable() @Tool()` implements MeshbotTool，对照 skill-install.tool.ts）。schema 关键点：`mcp_install` 为 `{ name: z.string().min(1), server: McpServerConfigSchema }`，description 写明「安装需用户确认；name 已存在会报错；变更下一轮对话生效」；install 的 execute：查重 → `port.confirmInstall(...)`（`ctx.signal` 透传，`ctx.sessionId`/`ctx.toolCallId` 从 ToolContext 取——确认 tool.types.ts 的字段名后使用）→ confirmed 才 `mcp.updateConfig(c => ({ mcpServers: { ...c.mcpServers, [name]: server } }))`。`@Optional` 注入 port，未注入（纯 lib 测试环境）时 install 返回「当前环境不支持确认，未安装」。其余四个工具直调 McpService，无确认
- [ ] **Step 4: server-agent 接线**：`mcp-confirm.module.ts` 对照 `ask-question.module.ts`（@Global + useExisting ConfirmationService + provide MCP_CONFIRM_PORT 实现类）；实现类 `waitForDecision` 挂起、决定映射为端口返回值；广播卡片状态复用现有 run 事件流（对照 ImSendService 的事件广播，若其广播逻辑在 service 内则同构新写）
- [ ] **Step 5: boot 验证 + 提交**　`pnpm build:server-agent && timeout 60 node apps/server-agent/dist/main.js`（无 DI 错误；完毕 `lsof -ti:7727 | xargs kill -9`）；commit `feat(agent): mcp_list/install/uninstall/enable/disable 五工具与 install HITL 端口`

---

### Task 4: 前端确认卡 + 工具友好名（与 Task 2/3 并行，文件集不重叠）

**Files:**
- Create: `packages/web-common/src/session/mcp-install-confirm-card.tsx`（对照 im-send-confirm-card.tsx 的结构/状态机/settled 处理）
- Modify: `packages/web-common/src/session/tool-call-block.tsx`（`mcp_install` 且非 streaming 分支挂卡）
- Modify: `packages/web-common/src/session/tool-display.ts`（TOOL_LABELS 补五个：MCP 列表/安装 MCP/卸载 MCP/启用 MCP/禁用 MCP）
- Test: `packages/web-common/src/session/mcp-install-confirm-card.spec.tsx`（jest：渲染 stdio/http 两形态、env/headers 只出 key、确认/拒绝回调、settled 态）

**Interfaces:**
- Consumes: `ToolCallBlock` 的 `onConfirm(toolCallId, "send"|"cancel")` 既有回调（决定线路复用 im_send 的 confirm 通道——与 Task 3 的 ConfirmationService.resolve 对接，无需新 REST/WS）
- Produces: `McpInstallConfirmCard({ tool, onConfirm, hitlSettledLabel })`

- [ ] **Step 1: 失败测试**（要点：args 从 `tool.args` 取 `{name, server}`；`"command" in server` 判 stdio 显示 command+args，否则显示 url+transport；env/headers 渲染 `Object.keys` 列表）
- [ ] **Step 2: 实现卡片与分支挂载**（卡内文案对齐 im-send-confirm-card 的中文直书/labels 混合现状；按钮：确认安装=brand、拒绝=outline）
- [ ] **Step 3: 跑绿 + 提交**　`pnpm --filter @meshbot/web-common test && pnpm format && pnpm typecheck`；commit `feat(web-common): MCP 安装确认卡与工具友好名`

---

### Task 5: 收尾验收

- [ ] **Step 1: 全量围栏**　`pnpm lint && pnpm typecheck && pnpm check && pnpm sync:locales -- --check && pnpm test && pnpm build`（基线对照：lint 预存在 error 在 server-agent spec 与 tools/browser）
- [ ] **Step 2: 变异抽查**　`mapServersToLangchainShape` 的 `enabled===false` 过滤条件取反 → 先 grep 打印确认变异落地 → 对应测试必须变红 → 还原确认全绿
- [ ] **Step 3: 真机验收清单（交用户）**
  - 对话让 agent 装一个 MCP（如 `npx -y @modelcontextprotocol/server-filesystem /tmp`）→ 确认卡出现、stdio 显示 command、env 值不泄露 → 拒绝一次（agent 收到拒绝文案）→ 再来一次并确认 → agent 回复含「下一轮生效」
  - 下一轮：`mcp_list` 能看到、`system:mcp` 生效（问 agent「你有哪些 MCP」应答对）、`mcp__<server>__*` 工具可用
  - `mcp_disable` 后下一轮工具消失、清单标「已禁用」；`mcp_enable` 恢复；`mcp_uninstall` 后清单消失
  - 编辑抽屉 MCP tab 手工加 `"enabled": false` 保存——人机两条写路径互通
  - 远程会话（web-main 观察端）安装确认卡可作答（L3 relay 通道）

---

## Self-Review 记录

- Spec 覆盖：§三→Task 2；§四→Task 1；§五→Task 1/3；§六→Task 4；§七→Task 5。§五「写操作返回文案」入 Global Constraints。无缺口。
- 占位符：Task 3 Step 3 的 ToolContext 字段名要求实施者先确认 tool.types.ts 再用（给了文件与判断方法，非 TBD）；Task 4 文案对齐现状为明确指令。
- 类型一致性：`updateConfig(mutator)` 签名 Task 1 定义、Task 3 消费一致；`getLoadedToolNames` Task 1/2 一致；端口返回四终态与卡片 onConfirm 的 send/cancel 映射在 Task 3 Step 4 与 Task 4 Step 2 各自对接 ConfirmationService 决定值——决定值语义沿用 im_send 的 `"send"|"cancel"`。
