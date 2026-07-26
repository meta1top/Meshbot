# MCP 感知注入与 agent 自管理工具集设计

日期：2026-07-26
范围：`libs/agent`（system:mcp 注入 + schema enabled + 五个内建工具 + McpService 收敛）+ `apps/server-agent`（MCP_CONFIRM_PORT 实现）+ `packages/web-common` / `apps/web-agent`（install 确认卡 + TOOL_LABELS）

## 一、背景

- Agent 的 MCP 工具名形如 `mcp__<server>__<tool>`（`@langchain/mcp-adapters` 按 `additionalToolNamePrefix:"mcp"` + `prefixToolNameWithServerName:true` 生成，与 Claude Code 官方约定完全一致），但系统提示里没有任何说明，agent 不知道这类工具的来源，也不知道自己装了哪些 MCP server。
- mcp.json 目前只能人在编辑抽屉里改；agent 无自管理能力。对照先例：技能已有 `skill_install` / `skill_search_market` 自管理工具集。
- 现状机制（设计基线）：mcp.json 按 Agent 隔离（`accounts/<cloudUserId>/agents/<agentId>/mcp.json`）；stdio（command/args/env）与 http（url/transport∈{sse,streamable_http}/headers）两类协议；每 Agent 首次 run 懒加载（`McpService.ensureAgent`，refCount + 闲置回收）；配置保存即 `teardownAgent`、下次 run 重建；**schema 无启用/禁用概念**。

## 二、已确认的决策

| 决策点 | 结论 |
|--------|------|
| 注入形态 | 新增第四条系统消息 **`system:mcp`**：静态格式说明 + 当前 Agent 的 server 清单（与 `system:skills` 目录同范式）。对照：Claude Code 无专门系统提示、纯靠名字前缀——本设计比它多给一层状态感知 |
| HITL | **仅 `mcp_install` 弹确认卡**（安装 stdio MCP = 授权常驻命令且配置持久化）；uninstall/enable/disable 直接执行 |
| 禁用语义 | schema 加 `enabled?: boolean`（缺省 true，向后兼容）；禁用 = 配置保留、不建连接 |
| 生效时机 | 沿用「落盘 → teardownAgent → 下次 run 重建」；**不做热加载**（graph bindTools 本轮已定），工具返回值明确告知「下一轮生效」 |

## 三、system:mcp 注入

- `ContextBuilder.buildMcpMessage(): SystemMessage`，稳定 id `system:mcp`；`graph-runner` 与另三条同点注入、每轮 `RemoveMessage` + 重建（改配置后老会话下一轮即感知）
- 内容结构：

```
<mcp>
名字形如 mcp__<server>__<tool> 的工具来自 MCP 服务器，由本 Agent 的 mcp.json 配置加载。
你可以用 mcp_list / mcp_install / mcp_uninstall / mcp_enable / mcp_disable 管理这些服务器（安装需用户确认；变更下一轮对话生效）。
已配置的 MCP 服务器:
- <name>（stdio | sse | streamable_http，已启用/已禁用，本轮已加载 N 个工具）
</mcp>
```

- 无任何配置时清单区替换为引导：「当前未配置任何 MCP 服务器。需要外部工具能力时可用 mcp_install 安装（需用户确认）。」
- 数据源：配置态 `McpService.loadConfig()`；运行态工具数需要 McpService 暴露只读 getter（现 `perAgent.names` 为 private）：`getLoadedToolNames(cloudUserId, agentId): ReadonlySet<string> | null`（null = 本轮尚未加载/无运行态，用「未加载」表述而非 0）

## 四、schema 变更（libs/agent/src/mcp/mcp.schema.ts）

- `StdioServerSchema` 与 `HttpServerSchema` 均加 `enabled: z.boolean().optional()`（语义缺省 true）
- `mapServersToLangchainShape` 过滤 `enabled === false` 的 server（不建连接）；`buildMcpMessage` 的清单**包含**禁用项（标「已禁用」）
- 手编 JSON 路径（编辑抽屉）天然获得该字段；PUT 校验自动放行

## 五、五个管理工具（libs/agent/src/tools/builtins/，@Tool 范式）

| 工具 | 参数（Zod schema） | 行为 |
|------|------|------|
| `mcp_list` | `{}` | 返回配置态全量（含禁用标记）+ 运行态（本轮已加载的 server 与工具名清单）|
| `mcp_install` | `{ name, server }`，`server` 为 stdio(`command/args?/env?`) 与 http(`url/transport?/headers?`) 的 union（复用 `McpServerConfigSchema` 单项） | HITL 确认 → 通过后写入；`name` 已存在则报错（避免静默覆盖，改配置走先 uninstall 或人工编辑）|
| `mcp_uninstall` | `{ name }` | 删除该 server 配置；不存在则报错 |
| `mcp_enable` / `mcp_disable` | `{ name }` | 翻转 `enabled`；不存在则报错；重复操作幂等成功 |

- 所有写操作返回值统一带「已生效于配置，**下一轮对话生效**——请告知用户」类文案
- **写入收敛**：现 PUT controller 内的「JSON 校验 + 落盘 + teardownAgent」下沉为 `McpService.updateConfig(mutator: (config) => config): Promise<void>`（读-改-写 + teardown 原子步骤），controller 与五个工具共用单一真相
- **HITL 链路**：`mcp_install` 经新端口 `MCP_CONFIRM_PORT`（`libs/agent/src/tools/mcp-confirm.port.ts`）→ server-agent 侧实现挂**现有 `ConfirmationService` 单例**（`useExisting` 复用 im-send.module 的 provide；严禁重复 provide——单例命门）。key 沿用 `${cloudUserId}:${sessionId}:${toolCallId}`。远程会话经 L3 relay 自动获得跨设备确认，无需新增通道
- 用户拒绝安装：工具返回「用户拒绝」终态（与 im_send cancel 同范式），不写配置

## 六、前端

- **`McpInstallConfirmCard`**（`packages/web-common/src/session/`，与 `im-send-confirm-card` 同族）：展示 server 名、协议、stdio 的 command+args 或 http 的 url（headers/env 只展示 key 不展示值——可能含密钥）、确认/拒绝双按钮、`hitlSettledElsewhere` 支持
- `ToolCallBlock` 挂新特化卡分支（`mcp_install` 且非 streaming）
- `TOOL_LABELS` 补五个友好中文名（新增内建工具的既有约定）；其余四个工具走通用工具行渲染即可

## 七、测试与验收

风险分档：**中**（本地配置写入 + HITL 单例命门 + 状态机简单）。实施 + 核心不变量变异抽查，不派独立 reviewer。

- 单测（jest，libs/agent 侧对齐现有 tools 测试形态）：
  - 五个工具：install 确认通过/拒绝路径、重名报错、uninstall 不存在报错、enable/disable 幂等、返回文案含「下一轮生效」
  - `updateConfig`：校验失败不落盘、成功后调 teardown
  - schema：`enabled` 缺省放行、`mapServersToLangchainShape` 过滤禁用项
  - `buildMcpMessage`：无配置引导文案 / 有配置清单（含禁用标记与未加载态）
- 变异抽查：`enabled=false` 过滤条件取反 → 断言测试变红 → 还原
- 真机验收：对话中让 agent 安装一个 MCP（确认卡出现、内容完整、headers 值不泄露）→ 拒绝一次 → 通过一次 → 下一轮 `mcp_list` 与 `system:mcp` 清单可见 → 禁用后下一轮工具消失
- `pnpm lint / typecheck / check / test / build` 全绿

## 八、明确不做

- MCP 热加载（本轮 run 内即用）——留后续优化
- MCP 市场/发现（对照 skill_search_market 的 marketplace）——本期只管配置内的增删启停
- server 连通性预检（install 时试连）——留后续
- WebSocket transport（Claude Code 支持、adapter 未接）——不扩协议
- 编辑抽屉 MCP tab 的表单化改造（仍是 JSON 文本编辑）
