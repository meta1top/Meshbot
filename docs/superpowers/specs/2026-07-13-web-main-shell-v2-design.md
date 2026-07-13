# web-main 对齐 web-agent（Shell v2）第一期 设计 spec

> 大目标分两期：一期壳对齐 + 完整云端 IM + 管理页套壳（本 spec)；
> 二期云端 ↔ 已授权设备会话（协议扩展 + 会话 UI 抽包，另立 spec）。
> 分支连续提交，完成后合并（沿用既有工作流）。

## 0. 需求（用户原话）

web-main 的 UI 还是老风格，web-agent 已重新设计（Shell v2 两栏暖橙）。目标：
web-main 对齐 web-agent——1) 没有本地 agent 功能，但云端可与所有已授权设备
会话（二期）；2) 多出云端功能：管理组织、成员、模型等。

已确认决策：两期切分；一级导航=助手/消息/技能/文件；管理入口放底部用户菜单；
一期做完整云端 IM（UI 抽包 + Transport 接口）；flows 不进导航。

## 1. 现状勘查结论

| 项 | 现状 |
|---|---|
| web-main 壳 | 深色 `WorkspaceRail` 单条 + 内容区（旧风格）；assistant 页是 stub |
| web-main 页面 | assistant(stub)/drive/flows(stub)/skills/settings/{org,models,devices} |
| web-main IM | **完全没有**（无 rest/组件/页面）；IM 界面只在 web-agent，数据在云端 |
| 可复用壳组件 | `packages/web-common/src/shell/` 全套（RailNav/SidebarNav/PageShellView/BrandLogo/AuthCard…），web-agent 的 `workspace-sidebar.tsx` 是拼装范本 |
| IM 数据流差异 | web-agent：浏览器→本机 server-agent（`/api/im/*` REST + ws/events 信封）→relay→server-main；web-main：浏览器→server-main 直连（REST + `ws/im` 用户 WS，认证/分流已存在——老 IM 时代的用户连接形态） |
| 设备列表 | `apps/web-main/src/rest/agent-devices.ts` 现成（含在线状态） |

## 2. 设计

### 2.1 壳与导航

- `(shell)/layout` 换两栏：浅色宽侧栏（264px：品牌行 → 一级图标条 →
  二级子栏 portal 插槽 → 底部用户块+主题切换）+ 内容区。组件全部来自
  `@meshbot/web-common/shell`，结构照 web-agent `workspace-sidebar.tsx`，
  视觉一致（暖米侧栏 / 橙 accent / --shell-* 变量）。
- 一级导航：**助手 / 消息 / 技能 / 文件**。`flows` 不进导航（路由保留可直达）。
- 底部用户块 dropdown：组织切换（现有）→ 组织与成员 / 模型管理 / 设备管理
  （路由沿用 `/settings/*`）→ 登出。旧 `WorkspaceRail` 删除。
- 二级子栏 portal 插槽模式照 web-agent（`SidebarSlotContext`）。

### 2.2 助手区（一期形态）

- 二级子栏：已授权设备列表（在线状态点），数据 `agent-devices` rest。
- 主区：选中设备详情卡（名称/平台/在线/最后活跃）+「远程会话将在后续版本
  开通」占位态。路由 `/assistant/[deviceId]` 一期就位，二期填会话界面。

### 2.3 IM 抽包（一期主体）

- 新增 `packages/web-common/src/im/`：
  - **纯 UI 组件**：会话列表（含未读）、消息流（文本/已读回执/时间分组）、
    输入框、频道创建/私聊发起面板、会话头（成员/改名）。组件无全局状态，
    props + 回调；样式沿用现 web-agent IM 视觉。
  - **`ImTransport` 接口**（纯 TS，无框架依赖）：
    `listConversations / listMessages(conversationId, cursor) / send /
    markRead / createDm / createChannel / addMember /
    subscribe({ onMessage, onPresence, onConversationCreated/Removed/Read })
    / presenceSnapshot`。
- **web-agent 适配器**（`apps/web-agent` 内）：包装现有本机链路——
  `/api/im/*` REST + ws/events 信封分发。**现有 IM 行为零变化是硬要求**，
  现有 jotai atoms 留在 app 层由适配器喂数据。
- **web-main 适配器**（`apps/web-main` 内）：直连 server-main IM REST +
  `ws/im` 用户 WS（JWT 认证，用户连接与设备连接的分流是既有语义）。
- 消息页：web-main 新增 `/messages` 路由，二级子栏=会话列表，主区=消息流。

### 2.4 管理页套壳

`settings/{org,models,devices}` 内容套 `PageShellView + PageHeader` 新壳；
成员管理保持在 org 页内。表单/逻辑不动，只动布局容器与入口（用户菜单）。

## 3. V1（一期）边界

- 设备会话（云端↔server-agent 的 run 链路与会话 UI）→ 二期。
- flows 流程平台、web-main 随手问 dock、深色主题细调 → 不做。
- IM 附件/表情回应/线程（web-agent 也未做的后端项）→ 不做。
- server-main 侧零 API 变更预期；若 web-main 直连缺个别 REST（如会话已读），
  按现 controller 风格补齐，不动协议语义。

## 4. 测试与验收

- ImTransport 接口与 UI 组件的纯逻辑单测（未读计数/时间分组/回调分发）。
- **web-agent IM 回归是一票否决项**：抽包后现有消息/频道/私聊/已读/presence
  全功能回归（现有测试 + 眼验）。
- 眼验：web-main 新壳四区导航；两端 IM 同屏互发（web-main 浏览器 ↔ web-agent
  桌面端，消息/已读/在线状态实时）；管理页从用户菜单进入且功能不回归；
  设备列表在线状态与助手区占位。

## 5. 风险

- IM 组件抽包侵入 web-agent 现有消息壳——靠回归测试 + 逐步替换（先抽组件
  在 web-agent 原位替换验证，再接 web-main）。
- web-main 用户 WS 的房间/事件语义按 server-main 现状核对（`ws/im` 用户
  连接是老形态，presence/conv room 广播已服务于 relay 设备连接，用户连接
  路径需实测确认无回归死角）。
