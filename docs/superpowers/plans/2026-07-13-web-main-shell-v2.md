# web-main Shell v2 一期 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** web-main 换 Shell v2 两栏暖橙壳 + 完整云端 IM（UI 抽包 + ImTransport 两端适配）+ 管理页套壳。

**Architecture:** 壳复用 `@meshbot/web-common/shell` 全套组件照 web-agent `workspace-sidebar.tsx` 拼装。IM 采用「UI 进 `web-common/im` + `ImTransport` 接口 + 两端适配器」：web-agent 适配器包现有本机链路（行为零变化一票否决），web-main 适配器直连 server-main（REST `/api/im/*` + `ws/im` 用户 WS，均为既有服务面）。

**Tech Stack:** Next.js + next-intl + jotai（留 app 层）+ socket.io-client + Tailwind v4

## Global Constraints

- 分支 `feat/web-main-shell-v2`，连续提交；中文 conventional commits。
- **web-agent IM 回归一票否决**：每个触碰 web-agent IM 的 Task 结束必须全量回归（现有 jest + `pnpm --filter @meshbot/web-agent typecheck`），行为零变化。
- `packages/web-common` 禁止依赖 jotai / app 内部路径；IM UI 组件只允许 props+回调，数据经 `ImTransport`。
- 前端文案 next-intl（两 app 各自 messages），`pnpm sync:locales -- --write`；品牌名 MeshBot。
- 视觉变量沿用 `--shell-*` 体系；不新增色值。
- server-main 预期零 API 变更；若缺个别 REST 按现 controller 风格补齐（不动协议语义），需配 e2e。
- 每 Task 结束：相关 typecheck + 测试 + 独立 commit。

---

### Task 1: web-main 两栏壳替换（含用户菜单管理入口）

**Files:**
- Create: `apps/web-main/src/components/shell/workspace-sidebar.tsx`
- Create: `apps/web-main/src/components/shell/sidebar-slot-context.tsx`
- Modify: `apps/web-main/src/app/(shell)/layout.tsx`
- Delete: `apps/web-main/src/components/shell/workspace-rail.tsx`
- Modify: `apps/web-main/messages/{zh,en}.json`（appShell 命名空间）

**Interfaces:**
- Consumes: `@meshbot/web-common/shell` 的 `BrandLogo/RailNav`；范本 `apps/web-agent/src/components/shell/workspace-sidebar.tsx`（结构逐段对照）与 `apps/web-agent/src/components/shell/sidebar-slot-context.tsx`（整文件形态一致）。
- Produces: `WorkspaceSidebar({ sublistSlotRef })`；`SidebarSlotContext` + `SidebarSlot`（后续 Task 3/6 的二级子栏 portal 用）；一级导航 keys：`assistant/messages/skills/drive`。

- [ ] **Step 1: sidebar-slot-context 复制适配**

把 `apps/web-agent/src/components/shell/sidebar-slot-context.tsx` 复制到 web-main 同名路径（该文件只依赖 react，无需改动——读一遍确认无 app 内部 import 后原样落地）。

- [ ] **Step 2: WorkspaceSidebar（web-main 版）**

以 web-agent 的 `workspace-sidebar.tsx` 为范本改写，差异点：
- 一级 items 四项：`assistant→/assistant`、`messages→/messages`、`skills→/skills`、`drive→/drive`（图标 Bot/MessageSquare/Blocks/Folder，无「更多」）。
- 底部用户块 DropdownMenu 在现有「组织切换/登出」之间插入管理三项：

```tsx
<DropdownMenuItem onClick={() => router.push("/settings/org")}>
  <Building2 className="mr-2 h-4 w-4" />
  {t("userMenu.orgAndMembers")}
</DropdownMenuItem>
<DropdownMenuItem onClick={() => router.push("/settings/models")}>
  <Cpu className="mr-2 h-4 w-4" />
  {t("userMenu.models")}
</DropdownMenuItem>
<DropdownMenuItem onClick={() => router.push("/settings/devices")}>
  <MonitorSmartphone className="mr-2 h-4 w-4" />
  {t("userMenu.devices")}
</DropdownMenuItem>
<DropdownMenuSeparator />
```

- 用户数据源用 web-main 的 `useProfile()`（无 currentUserAtom）；主题切换按钮照 web-agent 尺寸 `h-10 w-10`（与账号块 40px 等高——web-agent 已修过对齐坑）。
- 「新建任务」CTA 一期改为「发起消息」`router.push("/messages")`（i18n key `newMessage`）。

- [ ] **Step 3: layout 两栏装配**

```tsx
export default function ShellLayout({ children }: { children: ReactNode }) {
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  return (
    <main className="flex h-screen flex-col bg-(--shell-content) text-foreground">
      <div className="flex min-h-0 flex-1">
        <WorkspaceSidebar sublistSlotRef={setSlotEl} />
        <div className="relative flex min-h-0 flex-1 overflow-hidden bg-(--shell-content)">
          <SidebarSlotContext.Provider value={slotEl}>
            <OnboardingGate>{children}</OnboardingGate>
          </SidebarSlotContext.Provider>
        </div>
      </div>
    </main>
  );
}
```

（web-main 无 Electron 拖拽条/DragRegion；layout 需转 client 组件承载 useState——若 OnboardingGate 依赖 server 语义则确认后调整，现状它已是 "use client"。）删除 `workspace-rail.tsx` 及其引用。

- [ ] **Step 4: i18n + 验证 + commit**

zh：`appShell.rail.{assistant:助手,messages:消息,skills:技能,drive:文件}`、`appShell.newMessage:发起消息`、`appShell.userMenu.{orgAndMembers:组织与成员,models:模型管理,devices:设备管理}`；en 对应。`pnpm sync:locales -- --write`；`pnpm --filter @meshbot/web-main typecheck`。

```bash
git add -A && git commit -m "feat(web-main): Shell v2 两栏壳——浅色宽侧栏 + 管理入口进用户菜单"
```

---

### Task 2: 管理页套新壳

**Files:**
- Modify: `apps/web-main/src/app/(shell)/settings/org/page.tsx`
- Modify: `apps/web-main/src/app/(shell)/settings/models/page.tsx`
- Modify: `apps/web-main/src/app/(shell)/settings/devices/page.tsx`
- Modify: `apps/web-main/src/app/(shell)/skills/page.tsx`、`drive/page.tsx`（容器类对齐即可）

**Interfaces:**
- Consumes: `@meshbot/web-common/shell` 的 `PageShellView/PageHeader`（先 `grep -n "PageShellView" apps/web-agent/src/components/layouts/page-shell.tsx` 对照 web-agent 的用法照搬）。

- [ ] **Step 1**: 三个 settings 页的最外层容器换 `PageShellView` + `PageHeader`（标题用现有 i18n key），内部表格/表单一行不动。skills/drive 页外层容器类与 web-agent 同名页对齐（背景/圆角/内边距）。
- [ ] **Step 2**: 手验四条路由从用户菜单/导航可达且渲染正常；`pnpm --filter @meshbot/web-main typecheck`。
- [ ] **Step 3**: Commit `feat(web-main): 管理页与技能/文件页套 Shell v2 布局`。

---

### Task 3: 助手区（设备列表 + 二期占位）

**Files:**
- Modify: `apps/web-main/src/app/(shell)/assistant/page.tsx`（重写）
- Create: `apps/web-main/src/app/(shell)/assistant/[deviceId]/page.tsx`
- Create: `apps/web-main/src/components/assistant/device-sublist.tsx`
- Modify: `apps/web-main/messages/{zh,en}.json`

**Interfaces:**
- Consumes: `apps/web-main/src/rest/agent-devices.ts` 现有 hook（先读该文件确认签名——含设备 id/名称/平台/在线状态）；Task 1 的 `SidebarSlot`。
- Produces: 路由 `/assistant/[deviceId]`（二期填会话界面）。

- [ ] **Step 1**: `device-sublist.tsx`——SidebarSlot portal 进二级子栏：设备行（在线状态点 + 名称），点击 `router.push(\`/assistant/${id}\`)`，选中态高亮。列表加载态用 `Skeleton`（loading-states 技能：区块首载骨架）。
- [ ] **Step 2**: `/assistant` 主区空态（「选择左侧设备」）；`/assistant/[deviceId]` 详情卡：💻 图标 + 名称/平台/在线状态/最后活跃 + 占位条「远程会话将在后续版本开通」。设备不存在/离线态文案区分。
- [ ] **Step 3**: i18n + typecheck + commit `feat(web-main): 助手区设备列表与详情占位（二期会话留位）`。

---

### Task 4: ImTransport 接口 + web-common/im 骨架（TDD）

**Files:**
- Create: `packages/web-common/src/im/transport.ts`
- Create: `packages/web-common/src/im/transport.spec.ts`（纯逻辑：事件分发器）
- Create: `packages/web-common/src/im/index.ts`
- Modify: `packages/web-common/package.json`（exports 加 `"./im"`，照 `"./shell"` 条目形状）

**Interfaces:**
- Produces（后续所有 IM Task 的契约，签名逐字沿用）：

```ts
import type {
  ConversationSummary,
  ImConversationReadEvent,
  ImMessage,
  PresenceState,
} from "@meshbot/types";

/** IM 事件订阅回调集（信封/WS 事件由适配器归一后调用）。 */
export interface ImTransportEvents {
  onMessage: (m: ImMessage) => void;
  onPresence: (p: PresenceState) => void;
  onConversationCreated: (c: ConversationSummary) => void;
  onConversationRemoved: (conversationId: string) => void;
  onConversationRead: (e: ImConversationReadEvent) => void;
}

/** IM 数据传输接口：UI 组件唯一的数据入口，两端各自实现。 */
export interface ImTransport {
  listConversations(): Promise<ConversationSummary[]>;
  listMessages(
    conversationId: string,
    opts?: { before?: string; limit?: number },
  ): Promise<{ messages: ImMessage[]; hasMore: boolean }>;
  send(conversationId: string, content: string): Promise<void>;
  markRead(conversationId: string): Promise<void>;
  createDm(userId: string): Promise<ConversationSummary>;
  createChannel(name: string, memberIds: string[]): Promise<ConversationSummary>;
  addChannelMember(conversationId: string, userId: string): Promise<void>;
  listChannelMembers(
    conversationId: string,
  ): Promise<Array<{ userId: string; displayName: string }>>;
  /** 订阅事件；返回退订函数。适配器负责连接生命周期。 */
  subscribe(events: Partial<ImTransportEvents>): () => void;
  /** 当前在线快照（适配器缓存的 presence 状态）。 */
  presenceSnapshot(): Map<string, boolean>;
}

/** 多订阅者分发器：适配器内部复用（subscribe 多次调用互不覆盖）。 */
export class ImEventHub {
  /** 注册一组回调；返回退订函数。 */
  on(events: Partial<ImTransportEvents>): () => void;
  /** 分发单个事件到全部订阅者（逐个 try/catch 隔离，单个回调抛错不影响其余）。 */
  emit<K extends keyof ImTransportEvents>(
    kind: K,
    ...args: Parameters<ImTransportEvents[K]>
  ): void;
}
```

- [ ] **Step 1（TDD）**: `transport.spec.ts` 先写 `ImEventHub` 用例：多订阅者都收到、退订后不收、Partial 回调缺省不炸。跑红。
- [ ] **Step 2**: 实现 `ImEventHub`（Set<Partial<ImTransportEvents>>，emit 逐个 try/catch 隔离）+ 接口定义。跑绿。
- [ ] **Step 3**: exports 接线 + `pnpm --filter @meshbot/web-common build` + root jest 收集该 spec（web-common 在 root jest roots 外——若不收集，把 spec 放 `packages/web-common` 自己的 vitest？先查 `packages/web-common/package.json` 有无 test script；无则在 root `jest.config.ts` 的 roots 加 `<rootDir>/packages/web-common`——mapper 已有 `@meshbot/web-common` 映射，风险小）。
- [ ] **Step 4**: Commit `feat(web-common): ImTransport 接口与事件分发器（IM 抽包契约）`。

---

### Task 5: IM UI 组件抽到 web-common（web-agent 原位替换回归）

**Files:**
- Create: `packages/web-common/src/im/conversation-list.tsx`（从 web-agent messages 页的会话列表逻辑抽出）
- Create: `packages/web-common/src/im/message-flow.tsx`（从 `im-conversation-body.tsx` 抽出）
- Create: `packages/web-common/src/im/message-input.tsx`
- Create: `packages/web-common/src/im/conversation-header.tsx`（从 `im-conversation-header.tsx` 抽出）
- Create: `packages/web-common/src/im/channel-picker.tsx`、`dm-picker.tsx`
- Modify: web-agent 对应消费文件（原位替换为 web-common 组件 + 本地数据喂 props）
- Test: 现有 web-agent 全量回归

**Interfaces:**
- Consumes: Task 4 类型。
- Produces（web-main Task 6 直接消费的组件 props——实施时以此为准，抽取过程中发现缺 prop 就补到这里的形状上，不得让组件 import app 内部模块）：
  - `ConversationList({ conversations, activeId, presence, onSelect, onNewMessage })`
  - `MessageFlow({ messages, meUserId, hasMore, loadingMore, onLoadMore })`
  - `MessageInput({ onSend, disabled, placeholder })`
  - `ConversationHeader({ conversation, members, presence, onAddMember, onLeave, onRename })`
  - `ChannelPicker({ candidates, onCreate, onClose })` / `DmPicker({ candidates, onPick, onClose })`

**抽取模式（每个组件同一节奏，以 message-flow 为范例）：**

- [ ] **Step 1**: 读 `apps/web-agent/src/components/im/im-conversation-body.tsx`，把「渲染消息流」的 JSX+局部逻辑复制到 `packages/web-common/src/im/message-flow.tsx`，所有 `useAtomValue/apiClient/rest` 调用改为上表 props；`useTranslations` 改为接收 `labels` prop 对象（web-common 无 next-intl 上下文——labels: { loadMore, empty, readBy, ... } 由调用方注入，key 清单在抽取时按实际文案列全）。
- [ ] **Step 2**: web-agent 原文件改为薄容器：保留 atoms/rest/hooks 数据逻辑，渲染换 `<MessageFlow …props />`。
- [ ] **Step 3**: `pnpm --filter @meshbot/web-agent typecheck` + `npx jest apps/web-agent`（可收集部分）+ 手验该组件功能（消息流滚动/加载更多/已读）。
- [ ] **Step 4**: 独立 commit（每组件一个 commit：`refactor(im): 抽 <组件> 到 web-common（web-agent 原位替换零行为变化）`）。
- [ ] **Step 5**: 六个组件全部完成后跑全量：root jest + 两端 typecheck + `pnpm check`。眼验 web-agent IM 全功能（发消息/频道/私聊/已读/presence/未读数）——**一票否决项**。

（assistant-dock / quick-assistant-fab / dock-tabs 不抽——它们是 web-agent 专属容器。new-message-view 若与 picker 高度重合，抽 picker 后原位保留薄容器。）

---

### Task 6: web-main 适配器 + /messages 页面

**Files:**
- Create: `apps/web-main/src/lib/im-transport.ts`（直连 server-main 实现）
- Create: `apps/web-main/src/lib/im-socket.ts`（ws/im 用户 WS 单例）
- Create: `apps/web-main/src/app/(shell)/messages/page.tsx`
- Create: `apps/web-main/src/components/messages/messages-view.tsx`（装配：子栏会话列表 portal + 主区消息流）
- Modify: `apps/web-main/messages/{zh,en}.json`
- Test: `apps/web-main/src/lib/im-transport.spec.ts`（REST 路径/事件归一的纯逻辑部分）

**Interfaces:**
- Consumes: Task 4 `ImTransport`/`ImEventHub`、Task 5 全部 UI 组件、`mainApi`（Bearer getMainToken）。
- Produces: `createMainImTransport(): ImTransport`。

- [ ] **Step 1**: `im-socket.ts`——socket.io-client 连 `{API_BASE}/ws/im`，`auth: { token: getMainToken() }`（用户 JWT；im.gateway 用户连接分流是既有语义，实测确认握手成功）；单例 + 断线自动重连（reconnection 默认）＋ connect 后事件桥到 `ImEventHub`。
- [ ] **Step 2**: `im-transport.ts`——REST 映射（对照 `apps/server-main/src/rest/im.controller.ts` 实际路径）：
  - `listConversations → GET /api/im/conversations`
  - `listMessages → GET /api/im/conversations/:id/messages?before&limit`
  - `createChannel → POST /api/im/channels`、`createDm → POST /api/im/dms`
  - `addChannelMember → POST /api/im/channels/:id/members`、`listChannelMembers → GET 同路径`
  - `send → socket.emit("im.send", { conversationId, content })`（IM_WS_EVENTS.send 实际值以 `libs/types/src/im/im.events.ts` 为准）
  - `markRead → socket.emit(IM_WS_EVENTS.read, …)`（同上核对；若 server-main 只有 WS 无 REST 已读，用 WS）
  - `subscribe → hub.on(...)`；presence 快照由 socket 下行 presence 事件累积。
- [ ] **Step 3**: `/messages` 页装配：`ConversationList` portal 进 SidebarSlot；主区 `ConversationHeader + MessageFlow + MessageInput`；空态/骨架照 loading-states 技能。labels 从 web-main i18n 注入。
- [ ] **Step 4**: transport 纯逻辑单测（事件归一/presence 累积——socket 用注入的伪对象）；`pnpm --filter @meshbot/web-main typecheck`；sync:locales。
- [ ] **Step 5**: Commit `feat(web-main): 云端 IM——直连 transport 适配器 + 消息页`。

---

### Task 7: 全量回归 + 终验

- [ ] **Step 1**: `pnpm typecheck` 全仓 0 错；root jest 全绿；`pnpm --filter @meshbot/lib-agent exec vitest run` 282 绿；`pnpm check` 九围栏；sync:locales 对称。
- [ ] **Step 2**: `pnpm build:server-main`（若 Task 6 补过 REST）；两端 dev 起服。
- [ ] **Step 3**: 终验清单（眼验，需用户）：
  - [ ] web-main 新壳：四区导航/二级子栏/用户菜单管理三项/主题切换/组织切换
  - [ ] **web-agent IM 全功能无回归**（一票否决）：发消息/频道/私聊/已读/presence/未读数/新消息视图
  - [ ] 两端 IM 同屏互发：web-main 浏览器 ↔ web-agent 桌面端实时互通（消息/已读/在线点）
  - [ ] 管理页从用户菜单进入功能不回归；助手区设备列表在线状态正确 + 占位态
  - [ ] flows 直达路由仍可访问（不在导航）

## 回归结论

<!-- 终验通过后填写 -->
