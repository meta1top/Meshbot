# web-main 会话壳复用 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** web-main 渲染 web-agent 的实际会话壳组件（ChatInput / 产物右面板 / 侧栏展开树），删掉并行简化实现，交互与 web-agent 逐项一致。

**Architecture:** `SessionConversationView` 已在 web-common 且两端共用——缺口只是 web-main 传了简化叶子件。本计划把三个叶子件（ChatInput、ArtifactBody+右面板、设备→会话树）抽到 web-common，web-agent 原位复用（零回归），web-main 渲染同一套 + 远程 transport，本地专属项（技能/连应用/权限）在远程模式不注入即隐藏。

**Tech Stack:** Next.js + tiptap（已在 web-common）+ props/labels 注入模式（一期二期已验证）

## Global Constraints

- 分支 `feat/web-main-remote-session`，连续提交；中文 conventional commits。
- **web-agent 会话零回归一票否决**（本地+远程双形态）；每个触碰 web-agent 会话链路的 Task 结束跑全量 jest + 两端 typecheck + build。
- `packages/web-common` 禁 jotai / next-intl / app 路径 / apiClient；组件 props+labels 注入。
- 附件按钮（Paperclip）在 web-agent 本就是 mock no-op——原样保留，不新增远程文件能力。
- 技能/连应用/权限 = web-agent 注入的 `<ComposerActions/>`（mock 链）；web-main 远程模式**不注入**即隐藏，不打通远程。
- 视觉 class 沿用；不新增色值。i18n zh/en 对称，`pnpm sync:locales -- --write`。

---

### Task 1: 抽 ChatInput 到 web-common + web-agent 原位复用

**Files:**
- Create: `packages/web-common/src/session/chat-input.tsx`（从 `apps/web-agent/src/components/common/chat-input.tsx` 迁移）
- Modify: `packages/web-common/src/session/index.ts`（导出 ChatInput / ChatInputHandle / ChatInputProps）
- Modify: `apps/web-agent/src/components/common/chat-input.tsx` → re-export 兼容既有 import
- Modify: `apps/web-agent/src/components/session/assistant-conversation-body.tsx`（注入 labels）
- Test: 无（纯展示；随 web-agent 回归覆盖）

**Interfaces:**
- Produces: `ChatInput`（forwardRef）+ `ChatInputHandle` + `ChatInputProps`。相较现状新增 `labels: { attachment: string; interrupt: string; send?: string }`（替换内部 `useTranslations("...")`）；`formatTokens` 改从 web-common 本地 import（`./format-tokens`，已在 web-common）。其余 props（value/onChange/onSend/onInterrupt/isLoading/placeholder/leadingActions/trailingActions/modelName/tokenUsage）逐字不变。

- [ ] **Step 1: 迁移 + 去 app 依赖**

读 `apps/web-agent/src/components/common/chat-input.tsx` 全文 → 复制到 `packages/web-common/src/session/chat-input.tsx`：
- `import { useTranslations } from "next-intl"` 删除；`tChat("attachment")`/`tChat("interrupt")` 等改 `labels.attachment`/`labels.interrupt`（按文件实际 `t()` 调用列全 labels 字段）。
- `import { formatTokens } from "@/lib/format-tokens"` → `import { formatTokens } from "./format-tokens"`。
- tiptap import 不变（web-common 已装依赖，二期 chat 抽 message-input 时引入过）。

- [ ] **Step 2: web-agent 薄 re-export**

`apps/web-agent/src/components/common/chat-input.tsx` 改为：

```tsx
export {
  ChatInput,
  type ChatInputHandle,
  type ChatInputProps,
} from "@meshbot/web-common/session";
```

（若 ChatInputProps 当前未 export，迁移时一并 export。消费方 import 路径不变。）

- [ ] **Step 3: conversation-body 注入 labels**

`assistant-conversation-body.tsx` 装配 `<ChatInput>` 处加 `labels={{ attachment: tChat("attachment"), interrupt: tChat("interrupt") }}`（tChat 命名空间按原文件；缺的 key 从 web-agent messages 现有取，无新增 key）。

- [ ] **Step 4: 验证**

`pnpm --filter @meshbot/web-agent typecheck` + `npx jest apps/web-agent` + `pnpm --filter @meshbot/web-common test` + `pnpm --filter @meshbot/web-agent build`（确认 tiptap 编辑器在 web-common 下正常打包）。

- [ ] **Step 5: Commit** `refactor(session): ChatInput 抽到 web-common（web-agent 原位复用零行为变化）`

---

### Task 2: web-main 用真 ChatInput（删 RemoteChatInput）

**Files:**
- Modify: `apps/web-main/src/components/assistant/remote-session-view.tsx`（renderInput 换真 ChatInput）
- Delete: `apps/web-main/src/components/assistant/remote-chat-input.tsx`
- Modify: `apps/web-main/messages/{zh,en}.json`（补 ChatInput labels）

**Interfaces:**
- Consumes: Task 1 `ChatInput`；现有 `RemoteModelSelect`、`stream`（含 sessionTotals 供 tokenUsage）。

- [ ] **Step 1**: `renderInput` 改：

```tsx
renderInput={() => (
  <ChatInput
    value={draft}
    onChange={setDraft}
    onSend={(text) => void handleSend(text)}
    onInterrupt={stream.interrupt}
    isLoading={stream.running}
    placeholder={t("input.placeholder")}
    // 本地专属项（技能/连应用/权限）远程模式不注入 → 隐藏
    trailingActions={
      <RemoteModelSelect orgId={orgId} value={sessionModelId}
        onChange={(mid) => void handleModelChange(mid)} />
    }
    modelName={currentSession?.modelName ?? undefined}
    tokenUsage={
      stream.sessionTotals
        ? { current: stream.sessionTotals.lastInputTokens, max: contextWindow,
            breakdown: { /* 同 web-agent 字段映射，从 stream.sessionTotals 取 */ } }
        : undefined
    }
    labels={{ attachment: t("input.attachment"), interrupt: t("input.stop") }}
  />
)}
```

（contextWindow 从远程当前会话模型的 contextWindow 取；若 remote 无此字段则用 FALLBACK_CONTEXT_WINDOW，实施时对齐 web-agent 取法并报告。）

- [ ] **Step 2**: 删 `remote-chat-input.tsx`；`grep -rn RemoteChatInput apps/web-main/src` 确认无残留。
- [ ] **Step 3**: i18n（input.attachment 等）+ sync:locales + `pnpm --filter @meshbot/web-main typecheck` + build。
- [ ] **Step 4**: Commit `feat(web-main): 远程会话用完整 ChatInput（技能/应用/权限远程隐藏，保留模型/发送）`

---

### Task 3: 产物 ArtifactBody + 右面板抽到 web-common

**Files:**
- Create: `packages/web-common/src/session/artifact-body.tsx`（从 web-agent 迁 ArtifactBody，含 remote 分支）
- Create: `packages/web-common/src/session/artifact-split-pane.tsx`（右侧面板 chrome：标题/下载/关闭 + ArtifactBody；纯展示，target/onClose/labels 注入）
- Modify: `packages/web-common/src/session/index.ts`
- Modify: `apps/web-agent/src/components/artifact/artifact-body.tsx` → re-export；`artifact-split-pane.tsx` 复用共享 chrome（保留 previewArtifactAtom 装配薄壳）
- Test: `artifact-kind` 已有 spec；ArtifactBody 纯逻辑（base64/kind 判定）若可剥离补测

**Interfaces:**
- Produces:
  - `ArtifactBody({ path?, url?, name?, remote?, title?, transport?, labels })` —— 与现 web-agent ArtifactBody 同 props，`transport` 注入用于 remote 读取（替代 web-agent 直连 apiClient / web-main 的 fetchRemoteArtifact），app 各传自己的。
  - `ArtifactSplitPane({ target, onClose, labels })` —— 右侧面板 chrome。

- [ ] **Step 1**: 迁 ArtifactBody 到 web-common，数据读取改注入（web-agent 传本机 apiClient 适配、web-main 传 transport.readArtifact/uploadArtifactToDrive）；next-intl → labels；`@/` 依赖清除。
- [ ] **Step 2**: 抽 ArtifactSplitPane chrome（标题栏拖拽/下载/关闭——web-agent 现有交互原样搬，`app-no-drag` 等 Electron 类仅 web-agent 装配壳加）。
- [ ] **Step 3**: web-agent 原位复用（split-pane 薄壳保留 previewArtifactAtom + Electron 拖拽装配，正文用共享）；`pnpm --filter @meshbot/web-agent typecheck` + jest + build，**眼验 web-agent 产物预览（本地+远程+大文件网盘）零回归**。
- [ ] **Step 4**: Commit `refactor(session): ArtifactBody + 右面板抽到 web-common（web-agent 原位复用）`

---

### Task 4: web-main 产物改右面板（删弹窗）

**Files:**
- Modify: `apps/web-main/src/app/(shell)/assistant/layout.tsx`（挂右侧 ArtifactSplitPane aside，local state 驱动）或 `remote-session-view.tsx`（就近挂）
- Delete: `apps/web-main/src/components/assistant/artifact-preview-panel.tsx`
- Modify: `apps/web-main/messages/{zh,en}.json`

**Interfaces:**
- Consumes: Task 3 `ArtifactSplitPane` + `ArtifactBody`；现有 preview state（`setPreview`）。

- [ ] **Step 1**: 预览 target state 提到能挂右 aside 的层（assistant layout 或 device page 主区容器）；`onPreviewArtifact` 写 state → 右侧滑入面板（非 modal），面板正文 `ArtifactBody` 传 remote transport 数据源（大文件网盘路径复用）。
- [ ] **Step 2**: 删 `artifact-preview-panel.tsx`；确认无残留引用。
- [ ] **Step 3**: i18n + typecheck + build + Commit `feat(web-main): 产物预览改右侧面板（对齐 web-agent，删弹窗）`

---

### Task 5: 设备→会话展开树抽到 web-common + 两端复用

**Files:**
- Create: `packages/web-common/src/session/session-tree.tsx`（设备→会话树渲染：SidebarNav 组装 + 会话行下拉 + chevron + 自动展开高亮；纯数据/回调注入）
- Modify: `packages/web-common/src/session/index.ts`
- Modify: `apps/web-agent/src/components/shell/assistant-sidebar.tsx`（数据装配用共享树；jotai 留 app 层）
- Modify: `apps/web-main/src/components/assistant/assistant-sidebar.tsx`（改用共享树）
- Delete: web-main 本次自写的简化树逻辑（并入共享树）
- Test: 树纯逻辑（`isNavNodeActive` 已有；节点组装/自动展开若可剥离补 spec）

**Interfaces:**
- Produces: `SessionTree({ groups, activeSessionKey, onSelectSession, onExpandDevice, renderSessionActions?, onNewSession?, labels })` —— 数据模型沿用 NavGroup/NavNode（web-agent 现成），含：
  - 设备节点在线点 + chevron（在线可展开）；
  - 会话叶子下拉 actions（改名/删除；远程按 readOnly 裁剪，`renderSessionActions` 注入）；
  - 含 activeSessionKey 的设备分支 `defaultOpen`（刷新自动展开高亮）。

- [ ] **Step 1**: 从 web-agent `assistant-sidebar.tsx` + `session-list-item.tsx` 抽出树渲染 + 会话行（改名内联/删除确认/下拉）为共享 `SessionTree`，jotai/rest/next-intl 全改注入（labels + 回调）。
- [ ] **Step 2**: web-agent `AssistantSidebar` 改薄数据装配（devices/remoteSessions/sessions atoms → 组装 groups + 传 actions 回调接 rename/delete atoms），复用 SessionTree；**眼验 web-agent 侧栏本地+远程会话、改名/删除/展开/自动高亮零回归**。
- [ ] **Step 3**: web-main `assistant-sidebar.tsx` 改用 SessionTree（设备全远程；会话 actions 远程只读裁剪；chevron/自动展开/高亮随共享组件到位）；删本次自写简化树逻辑。
- [ ] **Step 4**: 全量 jest + 两端 typecheck + build + Commit `refactor(session): 设备→会话展开树抽到 web-common，两端复用`

---

### Task 6: CTA 文案对齐 + 全量回归 + 终验

**Files:**
- Modify: `apps/web-main/src/components/shell/workspace-sidebar.tsx`（「发起消息」CTA 语义——助手区应为「新建任务」对齐 web-agent；messages i18n）
- Modify: `apps/web-main/messages/{zh,en}.json`

- [ ] **Step 1**: 侧栏 CTA / 新建入口文案对齐 web-agent「新建任务」（i18n 改值，非新增键则复用）。
- [ ] **Step 2**: `pnpm typecheck` 全仓 / `pnpm test`（root+web-common）/ lib-agent vitest / `pnpm check` / sync:locales 全绿。
- [ ] **Step 3**: `pnpm build:server-main`（若涉及）；桌面 pack + `pnpm rebuild better-sqlite3`。
- [ ] **Step 4**: 终验（眼验，需用户）——**web-main 远程会话与 web-agent 逐项一致**：
  - [ ] 侧栏展开箭头 + 会话行下拉（改名/删除远程裁剪）+ 刷新自动展开高亮
  - [ ] 产物预览右侧面板（非弹窗，含大文件网盘路径）
  - [ ] 输入框：模型选择/发送在；技能/连应用/权限不在（远程隐藏）；token 用量环
  - [ ] 「新建任务」文案
  - [ ] **web-agent 会话零回归**（本地+远程全功能：流式/思考/工具/HITL/todo/用量/产物/改名删除/展开）

## 回归结论

<!-- 终验通过后填写 -->
