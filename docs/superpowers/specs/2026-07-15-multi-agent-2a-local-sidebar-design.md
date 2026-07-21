# 计划二 · 2a：本机 Agent 为主体的侧栏 设计

> 日期：2026-07-15
> 状态：**初版已实施（Task 1-4，commit f6e9102c..083ac749），2026-07-16 模型修订，见下方「修订 v2」**
> 上游：`2026-07-15-multi-agent-per-device-design.md`（§9 计划二 IA 愿景）

---

## 修订 v2（2026-07-16）—— 去掉「全局当前 Agent」，Agent 为并列组织维度

用户实机 review 初版后推翻了「单一全局当前 Agent」这个中间模型。**以下修订 supersede 本文档中所有关于 `currentAgentIdAtom`「单一当前 Agent」「点 Agent 设为当前 + 高亮」的表述**（§已确认决策的「当前 Agent 模型」、§侧栏结构里点节点设当前那条、以及初版 Task 2 里的 onSelectAgent / resolveCurrentAgentId / filterSessionsByAgent 语义）。

**新模型：Agent 是「一直并列列出、每处独立挑选」的组织维度，没有全局当前态。**

1. **彻底删除 `currentAgentIdAtom`**（全局单选语义）及其全部消费方的「当前」依赖。计划一 Task 12 曾把 6+ 处接到它，每处的 agentId 来源改为「就地选择」。
2. **起手台（launcher）**：目标选择器从「设备下拉」改成「Agent 下拉」——下拉选项**直接就是各个本机 Agent**（扁平，不先展开「本地」）。选一个 Agent → 发起的本地会话归它。远程设备/Agent 留给 2c。
3. **技能页**：从「按当前 Agent 过滤」改成**主从视图**——左侧列**所有**本机 Agent（含零技能的），点一个 → 右侧列它已装的技能 + 给它装新技能。
4. **侧栏**：Agent→会话列表保留，但**去掉「点 Agent = 设为当前」和当前高亮**。点 Agent 行只展开/收起它的会话；点会话打开（会话自带 agentId，无歧义）；`onSelectAgent` 移除。新建会话走起手台的 Agent 下拉。

**初版仍复用的部分**（不推翻）：SessionTree 的 `agent` kind + AgentRow（头像/running 点/编辑铅笔）、侧栏 Agent→会话分组（`groupSessionsByAgent`）、捞回的编辑抽屉、会话头显归属 Agent。

**修订实施见**：`docs/superpowers/plans/2026-07-16-multi-agent-2a-revised.md`。

下方为初版设计原文（当前 Agent 相关部分已被上面 supersede，保留作记录）。

---

## 背景

计划一交付了「一设备多 Agent」的本地地基（agents 表 / 会话绑定 Agent / 路径·工具·MCP·人格全部按 Agent 隔离），临时用「最左 Agent 图标条」做切换。用户 review 后确定图标条方向不对：Agent 应是导航主体、设备降为元数据。图标条已删（commit `0d37a770`）。

计划二拆三个子项目：**2a**（本机 Agent 侧栏，纯本地）、2b（云端注册 + agentId 寻址）、2c（远程 Agent 打通 + web-main IA）。本文档只覆盖 **2a**。

**2a 目标**：web-agent 侧栏从「设备→会话树」重构成「本机 Agent→会话嵌套列表」，把创建/编辑 Agent 的入口按新 IA 接回来，会话头部显示归属 Agent。不碰云端。做完立刻补上删图标条后缺失的 Agent 切换/管理入口，并把本地体验理顺。

## 已确认的设计决策

| 决策点 | 结论 |
|---|---|
| 侧栏过渡期结构 | **上下两区**：上区 = 本机 Agent→会话列表（新 IA）；下区 = 其他设备远程会话（设备→会话，现状不动，2c 换成远程 Agent） |
| 当前 Agent 模型 | 沿用 `currentAgentIdAtom`「单一当前 Agent」——点 Agent 节点即设为当前 + 展开会话；新建会话/技能页/侧栏过滤都用它（Task 12 已接线，不重接） |
| 创建/编辑入口 | **抽屉，从侧栏触发**：捞回删掉的 `AgentEditorSheet`，「+ 新建 Agent」开新建、hover Agent 行出铅笔开编辑 |
| 会话头部 | 显示归属 Agent（头像 + 名字）；设备位预留但 2a 不填（本机不必显示，2c 标宿主设备） |

## 侧栏结构

```
┌─ 侧栏 ────────────┐
│ 本机 Agent          │  ← 上区（新 IA）
│  ▾ 🛠 研发助手 ●     │     ● = 有会话在跑（脉冲点）
│      会话 A         │
│      会话 B         │
│  ▸ ✍ 写作助手       │
│  ▸ ⚙ 运维值班       │
│  + 新建 Agent       │
│ ─────────────────  │
│ 其他设备            │  ← 下区（过渡态，现状不动）
│  ▸ 💻 台式机（远程）  │
│  ▸ 💻 服务器（远程）  │
└───────────────────┘
```

**上区 = 本机 Agent→会话**（复用 `SessionTree` 组件 + `NavNode[]` 机制）：
- 每个 Agent 一个可展开节点（头像 + 名字），子节点 = `sessions` 里 `agentId === agent.id` 的会话。
- 点 Agent 节点 → 设 `currentAgentIdAtom` + 展开该 Agent 的会话。
- Agent 节点显示运行中脉冲点（该 Agent 名下有 `status === "running"` 的会话）——`SessionSummary.agentId`（Task 12 已加）使这成为可能。
- 底部「+ 新建 Agent」开编辑抽屉（新建模式）。
- hover Agent 行出铅笔 → 编辑抽屉（编辑模式）。

**下区 = 其他设备**（现状不动）：设备→会话树，但**去掉「本机」节点**——本机不再是设备节点，它被展开成上区的 Agent 列表。下区只渲染 `!device.isCurrent` 的其他设备（远程会话入口，过渡态）。

**数据来源**：
- 本机 Agent 列表：`useAgents()`（从 git 历史 `0d37a770^` 捞回 `rest/agents.ts`）。
- 会话：现有 `sessionsAtom`（本账号全部本机会话），按 `agentId` 分组。**必须用同一份数据**，不引入第二数据源。
- 首屏无当前 Agent 时自动选第一个（捞回 `resolveCurrentAgentId`）。

## 编辑抽屉

从 `0d37a770^` **原样捞回**，按新 IA 接线（不捞 `agent-rail.tsx`，图标条永久废弃）：

| 文件 | 作用 |
|---|---|
| `components/agent/agent-editor-sheet.tsx` | 名字/emoji+背景色头像/描述/system prompt/默认模型/复制/删除 |
| `components/agent/mcp-editor.tsx` | 抽屉内 MCP 配置区（JSON 编辑 + 校验） |
| `components/agent/agent-avatar-field.tsx` | emoji + 预设色块头像选择器 |
| `rest/agents.ts` | Agent REST 客户端（list/create/update/delete/duplicate/mcp 读写 + `useAgents()`） |
| `lib/agent-avatar.ts`（+spec） | `emoji\|色值` 解析 |
| `lib/resolve-current-agent.ts`（+spec） | 首屏自动选中当前 Agent |
| `lib/next-selected-agent-id.ts`（+spec） | 删除后选下一个（含 Task 11 修过的 Critical：只在删的是当前选中时才切） |

接线换到新侧栏：「+ 新建 Agent」→ 新建模式；hover Agent 行铅笔 → 编辑模式。保留删掉时已审查/修过的全部逻辑：`nextSelectedAgentId` 的「只切当前选中」、只剩一个 Agent 禁删、删除确认文案（「会同时删除该 Agent 的全部会话、记忆与工作区文件，不可恢复」）。

**捞回的硬约束**：这些文件删除时 `check:dead` 是绿的（消费方一起删了）。捞回后**必须在同一步接上新侧栏消费方**，否则捞回的导出没人用 → `check:dead` 变红。「捞回文件」和「接线新侧栏」是一个不可分割的 Task。

## 会话头部

会话主区顶部显示归属 Agent（头像 + 名字）。数据源：会话的 `agentId`（`SessionSummary.agentId` 已有）→ `useAgents()` 查名字/头像。设备位（本机/远程设备名）**预留但 2a 不填**，2c 在此标宿主设备。

## 新建 / 大改的文件

| 文件 | 改动 |
|---|---|
| `apps/web-agent/src/components/shell/assistant-sidebar.tsx` | 核心重构：`buildChildren` 的 `d.isCurrent`（本机）分支移除，改成上区按 Agent 分组；下区设备树只渲染 `!isCurrent` 设备 |
| `apps/web-agent/src/lib/group-sessions-by-agent.ts`（新，+spec） | 会话按 `agentId` 分组 + 每组是否有 running（纯函数，好测） |
| web-agent 会话头部组件 | 加「当前 Agent」头像+名字展示 |
| `apps/web-agent/src/app/(shell)/layout.tsx` | 无需再改（图标条已在 `0d37a770` 移除） |

**保留不动**：`currentAgentIdAtom`、`filterSessionsByAgent`、后端 `SessionSummary.agentId`、多 Agent 后端全部。

## 测试

**纯函数单测**
- `groupSessionsByAgent`：空 / 单 Agent / 多 Agent / running 聚合（某 Agent 有 running 会话 → 该组标记 running）。
- `resolveCurrentAgentId`、`nextSelectedAgentId`、`parseAgentAvatar`：捞回的 spec 直接复用。

**组件 / 构建**
- `pnpm --filter @meshbot/web-agent build`（沙箱无网时 Google Fonts 拉取会失败，属环境限制非回归——以 typecheck + jest 为准）。
- `pnpm --filter @meshbot/web-agent typecheck`、web-agent jest。
- `pnpm check`（尤其 `check:dead` 确认捞回文件都有消费方）。

**手工冒烟（交用户真机）**
- 建两个 Agent → 上区两个可展开节点，各展开各自的会话。
- 点 Agent A → 设为当前；建会话 → 落在 A 下；切到 B → B 的会话列表是 B 的。
- 编辑 A 改名/换头像/删除（删到只剩一个时禁删）。
- 下区其他设备的远程会话仍可进入。
- 会话头部显示当前会话归属的 Agent。

## 风险

1. **捞回文件与新侧栏接线必须同一步**——否则中途 `check:dead` 会红（捞回的导出暂时没消费方）。plan 写成一个不可分割的 Task。
2. **会话数据单一来源**：分组必须基于 `sessionsAtom`（现在 `filterSessionsByAgent` 就靠它），别引入第二数据源导致上区列表与实际会话不一致。
3. **下区去本机节点后的 key 体系（最容易出 bug）**：现在 `activeSessionKey` 本地会话用 `s:<id>`、远程用 `r:<deviceId>:<id>`；本机会话的祖先原是「本机设备节点」，现在变成「Agent 节点」。高亮当前会话 + 自动展开祖先分支的 key 匹配要重新对齐——上区 Agent 节点的 key 前缀、本地会话 key 与 Agent 节点的父子关系都要重新设计，否则刷新后当前会话不高亮、祖先 Agent 不自动展开。

## 交付后的状态

- web-agent 侧栏 = 本机 Agent→会话列表（上区）+ 其他设备远程（下区）。
- 创建/编辑/删除/复制 Agent 全部可用（抽屉从侧栏触发）。
- 会话头部显示归属 Agent。
- 本地多 Agent 体验完整、可切换、可管理。

**不做**（2b/2c）：云端注册、agentId 寻址、远程 Agent 出现在本机列表、web-main IA、双轨对等技能。下区「其他设备」保持设备→会话的过渡形态，2c 换成远程 Agent。
