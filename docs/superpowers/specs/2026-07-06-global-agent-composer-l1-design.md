# 全局 Agent 输入框改版 · L1 设计

**日期**：2026-07-06
**范围**：仅 L1（纯前端 web-agent 输入框改版）。L2（跨设备 agent/会话列表）、L3（在线远程交互）另开设计。

## 背景与分层

需求整体分三层，后端依赖递增，本次只做 **L1**：

- **L1 · 输入框改版（纯前端）**：composer 布局对齐 `dist/mockup.html`。← 本 spec
- **L2 · 跨设备 agent/会话列表（需云端）**：选择器与「助手」模块列出该账号所有注册设备 + 其他设备会话 + 在线态。
  - 已知：后端能力基本齐全（`GET /api/devices`、`GET /api/conversations` 中 `agentDeviceId≠null`、`GET /api/devices/:id/online` + presence），web-main 已有成品 UI（AgentPicker / ImSidebar）；web-agent 侧缺分组与选择器封装。
- **L3 · 在线远程交互（IM 反向通道）**：选中其他设备在线 agent，用相同聊天交互对话。
  - 已知缺口：(a) web-agent 到云端只有 device-token relay 一条通道，被 `ImGateway` 当「agent 回流」侧，无法以「人」身份远程驱动别的设备；(b) 交互只有单条最终回复、无流式与富事件跨云回传。

L2/L3 的架构调查见对话记录，不在本 spec 展开。

## L1 目标

把 web-agent 的 agent 输入框（composer）改成 mockup 样子：

1. **底部动作栏**：左「技能 / 连应用 / 权限」mock 下拉；右「上传(📎 mock) + 发送(↑)」并排。发送键从编辑区行内移到动作栏右端，上传紧挨发送左侧。
2. **去掉常显富文本格式工具栏**；保留 tiptap 的 markdown 输入规则（打 `**粗**`、`# 标题`、`- 列表`、\`\`\`code\`\`\` 等自动可视化）。
3. **顶部选择器行（仅起手台）**：`[🖥 选择 agent：本地 ▾]  [📁 选择工作空间 ▾]`。

## 关键约定（已与用户确认）

- **工作空间** = agent 文件工作区（server-agent `.meshbot/accounts/<id>/workspace` 下的目录）。L1 只做 UI 壳，默认「默认工作区」，下拉占位。
- **选择 agent**：默认「本地」选中；其他设备项置灰「即将支持」占位（L2 接真数据）。
- **上传按钮**：L1 为 mock 占位（点击 coming-soon），不接真实上传。
- **技能 / 连应用 / 权限**：保持 mock 按钮（点击 coming-soon）。
- **格式工具栏**：全部 composer 去掉；markdown 自动可视化保留（tiptap StarterKit 输入规则 + tiptap-markdown 粘贴/复制）。

## 组件设计

### 1. `ChatInput` 内核重构（`apps/web-agent/src/components/common/chat-input.tsx`）

- **删除** `minimal` 分叉与常显格式工具栏（Bold/Italic/... 那一条）。tiptap 编辑器与 StarterKit 输入规则、tiptap-markdown 保留不动。
- **新增底部动作栏**（始终渲染）：
  - 左：`leadingActions?: ReactNode` 槽（父组件传入 mock 链；不传则左侧空）。
  - 右：上传按钮（📎，mock，内置，点击 coming-soon tooltip）+ 发送按钮（↑，从编辑区行内迁来）+（可选）token 用量环（`tokenUsage` 存在时显示，移入动作栏右侧）+ 运行时的中断按钮（`isLoading` 时替代/并列发送，沿用现逻辑）。
- **Props 变化**：
  - 移除 `minimal`。
  - 新增 `leadingActions?: ReactNode`。
  - 其余（`value/onChange/onSend/onInterrupt/isLoading/placeholder/modelName/tokenUsage`）保留。
- 编辑区行不再放发送键（迁到动作栏）。

### 2. `ComposerActions`（新组件，mock 链）

- 位置：`apps/web-agent/src/components/common/composer-actions.tsx`（或就近）。
- 渲染「技能 ▾ / 连应用 ▾ / 权限 ▾」三个 mock 下拉按钮（带 ChevronDown），点击 coming-soon tooltip，无副作用。
- 走 i18n（`useTranslations`），复用现有 `home.composer.*` 文案键（`skills/apps/permissions/comingSoon`），必要时补键。
- 作为 `leadingActions` 传给 agent 任务 composer。

### 3. `ComposerTargetBar`（新组件，仅起手台顶部）

- 位置：`apps/web-agent/src/components/home/composer-target-bar.tsx`（或就近）。
- 渲染一行两个下拉壳：
  - **选择 agent**：默认「本地」，其他项置灰「即将支持」。
  - **选择工作空间**：默认「默认工作区」，下拉占位。
- L1 纯 UI 壳，无真实数据/状态（可用本地 state 表现选中态，但不接后端）。i18n 补文案键。

## 应用范围（各 composer）

| composer | 文件 | 新动作栏 | 技能/连应用/权限 链 | 顶部选择器行 |
|---|---|---|---|---|
| 起手台 | `home/launcher-home.tsx` | ✅ | ✅ | ✅ |
| 主会话 | `session/assistant-conversation-body.tsx` | ✅ | ✅ | ✗ |
| 随手问 | `im/assistant-dock.tsx` | ✅ | ✅ | ✗ |
| IM 会话 | `im/im-conversation-body.tsx` | ✅（仅上传移位/去工具栏） | ✗ | ✗ |
| 新消息 | `im/new-message-view.tsx` | ✅（同上） | ✗ | ✗ |

- 起手台：移除现有「技能/连应用/权限」独立行（迁入 ChatInput 的 `leadingActions`），上方加 `ComposerTargetBar`。
- 所有 composer 因 ChatInput 统一，自动获得「发送在动作栏 + 上传在旁 + 无格式工具栏」。
- 仅 agent 任务 composer 传 `leadingActions={<ComposerActions/>}`；IM 会话不传。

## 非目标（L1 明确不做）

- 真实文件上传、真实 agent 列表 / 其他设备、真实工作空间切换。
- 列出其他设备会话、在线态、远程交互（L2/L3）。
- 后端改动、server-main / IM 反向通道改动。

## 测试与验证

- L1 以视觉/交互为主。ChatInput 若抽出纯逻辑（如动作栏是否显示的判定）可加轻量单测；否则不强加 React 组件测试（web-agent 现有 spec 均为纯函数）。
- 主要验证：`pnpm dev:desktop` 跑桌面端，逐个 composer 目视核对（起手台顶部选择器 + 动作栏；会话内动作栏；发送/上传位置;markdown 自动可视化;IM 会话无 agent 链）。
- 静态围栏：Biome + `pnpm typecheck`（web-agent）。i18n 围栏（新文案键补齐，`i18n-page` 规范：禁止裸字符串）。

## 风险 / 注意

- ChatInput 是 5 处共享组件，重构需回归全部 5 个 composer（尤其发送键迁位后的键盘发送、中断按钮、token 环仍正常）。
- 去掉格式工具栏后确认 tiptap 输入规则仍生效（StarterKit 默认开启；tiptap-markdown 已挂）。
- i18n：新增/复用文案键需中英齐全，过 `i18n-page` 规范。
