# web-main 会话壳复用（真·一套交互）设计 spec

> 二期远程会话（feat/web-main-remote-session）落地后，终验发现 web-main 是
> 「另一套简化交互」而非复用 web-agent。本 spec：把 web-agent 的会话壳抽到
> web-common，web-main 渲染同一套组件——交互字面上一份代码。同分支续做。

## 0. 缘起（终验暴露的差异）

web-main 相较 web-agent 缺：侧栏展开箭头、会话行下拉菜单、刷新自动展开+高亮、
产物右面板（现为弹窗）、完整输入框（现为 remote-chat-input 简化版，无技能/
应用/权限/模型/文件）、「新建任务」（现为「发送消息」）。

**根因**：一期二期的抽包只到「消息流 hook + 消息组件」层；web-agent 的
`assistant-conversation-body`（本地+远程**共用**的会话视图，含完整 ChatInput +
产物右面板 + readOnly 语义）与 `AssistantSidebar`（展开树）这层壳没抽，
web-main 于是另写了简化实现。故成两套。

**已确认方向**：抽壳复用；ChatInput 的纯本地 agent 控件（技能/连应用/权限）
在远程模式隐藏，模型（已有远程选择）/文件/发送保留。

## 1. 现状勘查结论

| 组件 | web-agent 现状 | web-main 现状（本 spec 要替换） |
|---|---|---|
| 会话视图 | `components/session/assistant-conversation-body.tsx`（336 行，`remoteDeviceId` 切本地/远程，含 ChatInput/artifact/readOnly） | `components/assistant/remote-session-view.tsx`（并行简化实现） |
| 输入框 | `components/common/chat-input.tsx`（完整：技能/连应用/权限/模型/文件/发送） | `remote-chat-input.tsx`（简化） |
| 产物预览 | 右侧 `ArtifactSplitPane`（`(shell)/layout.tsx` 常驻 aside） | `artifact-preview-panel.tsx`（弹窗 modal） |
| 助手侧栏 | `components/shell/assistant-sidebar.tsx`（设备→会话展开树，jotai atoms，含 chevron/会话行下拉/自动展开高亮） | `components/assistant/assistant-sidebar.tsx`（本次刚写的简化树，无下拉/自动展开） |
| 会话 hook / 消息组件 | 已在 `packages/web-common/src/session/`（一期二期成果） | 已复用 web-common |

## 2. 设计

### 2.1 抽 `SessionConversationView` 到 web-common

- 把 `assistant-conversation-body` 的**渲染壳**抽为 `packages/web-common/src/session/session-conversation-view.tsx`：消息列表 + ChatInput + 产物右面板挂载点 + PendingList，接 `SessionTransport` + 注入回调/labels（沿用一期二期 props 模式，禁 jotai/next-intl/app 路径）。
- `remoteDeviceId` 语义保留：`mode: "local" | "remote"` + `readOnly` 由调用方传；两端各自装配（web-agent 传本地/远程 transport + jotai 桥，web-main 传远程 transport）。
- web-agent 的 `assistant-conversation-body` 改薄容器复用它；**web-agent 本地+远程会话零回归一票否决**。

### 2.2 抽 `ChatInput` 到 web-common + 远程模式门控

- `ChatInput` 抽到 `packages/web-common/src/session/chat-input.tsx`，工具栏项改为**能力驱动**：`capabilities: { skills?; apps?; permissions?; model; files }`——每项由调用方决定是否渲染 + 数据/回调注入。
- web-agent：全开（技能/应用/权限/模型/文件），数据接本地 REST（行为零变化）。
- web-main 远程模式：技能/应用/权限**隐藏**（`capabilities` 不传）；模型接现有远程模型选择、文件接远程工作区上传（走设备通道，若本期不做文件则也隐藏并记边界）、发送保留。
- 纯本地控件的数据 hook 留 web-agent（不进 web-common）。

### 2.3 产物右面板复用

- `ArtifactSplitPane`（右侧滑入面板）抽到 web-common 或做成共享；web-main 用它替换弹窗 `artifact-preview-panel`。远程数据源走 transport（一期已有 remote 分支）。删弹窗实现。

### 2.4 助手侧栏树复用

- 把 web-agent 的 `AssistantSidebar` 树抽为共享组件（数据注入：设备列表 + 各设备会话 + 在线态 + 会话行 actions），两端渲染同一棵树：
  - **展开 chevron**（SidebarNav 现成，本次简化版被 renderRow 覆盖掉了 icon 导致丢箭头——复用真组件即修复）；
  - **会话行下拉菜单**（改名/删除等，web-agent `SessionListItem`；远程会话按只读能力裁剪可用项）；
  - **刷新自动展开 + 高亮**（`isNavNodeActive` → 含 activeKey 的设备分支 `defaultOpen`）；
  - web-main：设备全为远程；web-agent：本机 + 远程混合。
- 删 web-main 本次刚写的简化树。

### 2.5 首页/CTA 文案

- 侧栏 CTA「发送消息」→「新建任务」（对齐 web-agent，i18n 改键值）；助手区新建入口语义对齐。

## 3. 边界

- **不做**（远程语义未通/超范围）：远程技能/连应用/权限打通（用户选「隐藏」而非全量）；web-main 首页工作区/agent 选择（本地概念）；文件远程上传若牵出设备通道新协议则降级为隐藏并记边界。
- **不改**：B 端 server-agent、L3 协议、会话流 hook 语义。

## 4. 测试与验收

- **web-agent 会话零回归一票否决**（本地+远程双形态：流式/思考/工具/HITL/todo/用量/产物/重生成/反馈/侧栏改名删除/展开）——每个触碰 web-agent 会话链路的 Task 全量回归。
- transport/纯逻辑单测延续。
- 眼验对齐：web-main 远程会话与 web-agent 远程会话**逐项一致**——展开箭头、会话行下拉、刷新自动展开高亮、产物右面板、输入框（模型/文件/发送在、技能/应用/权限不在）、新建任务文案。

## 5. 风险

- 抽 `assistant-conversation-body` + `ChatInput` 是动 web-agent 活组件，回归面大——策略同一期二期：先抽 + web-agent 原位替换保持全绿，再接 web-main；逐组件独立 commit + 回归。
- ChatInput 能力门控要确保 web-agent 全开路径与旧行为逐项等价（默认全开，缺省不改现状）。
