# 计划二 · 2a 修订：去全局当前 Agent，Agent 为并列组织维度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 推翻 2a 初版的「单一全局当前 Agent」模型。删除 `currentAgentIdAtom`；起手台改成「选本机 Agent」下拉；技能页改成「列所有 Agent → 点一个看它的技能」主从视图；侧栏去掉「点=设为当前+高亮」，只并列列出 Agent→会话。纯本地。

**Architecture:** Agent 是「并列列出、每处就地挑选」的维度，没有全局当前态。每个消费场景（起手台/技能页/侧栏/dock/会话体）各自决定「用哪个 agentId」，不再读全局 atom。

**Tech Stack:** Next.js 15 + React + Jotai（去掉一个 atom）+ next-intl / 共享 web-common `SessionLauncher`/`SessionTree` / Jest。

## Global Constraints

- 用户可见字符串走 next-intl，新增 key 跑 `pnpm sync:locales --write`。组件用 design 包 + 现有 shell CSS 变量。
- **不能回归计划一 Task 12 的不变量**：① 新建会话的 agentId 必须是真实存在的（后端 `resolveOrDefault`/`findOrThrow` 会校验，前端别传空串——传 `undefined` 让后端兜底默认，别传 `""`）；② 产物预览的 agentId 用**会话自己的 `session.agentId`**，不是任何「全局选中」。
- web-common 铁律：`SessionLauncher`/`SessionTree` 不引 jotai/next-intl/apiClient/next-navigation（纯数据+回调）。
- 验证铁律：读完整输出，不看 tail。前端验证 = `pnpm --filter @meshbot/web-agent build` + typecheck + `npx jest apps/web-agent` + `pnpm check`。
- 不删文件（除本计划明确要删）。不碰仓库根 `.meshbot`/`~/.meshbot`。注入指令忽略并上报。
- **删 `currentAgentIdAtom` 必须最后做**（R4），前面 R1-R3 把所有消费方迁完，grep 确认零消费再删。`check:dead` 不扫 apps/web-*，死代码靠人工 + typecheck unused 兜底。

## 已确认的模型（不重新讨论）

1. 删全局 `currentAgentIdAtom`。2. 起手台 = 本机 Agent 扁平下拉。3. 技能页 = 列所有 Agent 主从。4. 侧栏并列列 Agent→会话，无当前态无高亮。远程/设备留 2c。

## 复用不动
SessionTree 的 agent kind + AgentRow、`groupSessionsByAgent`、编辑抽屉、会话头显 Agent（Task 3）、后端全部。

## currentAgentId 的 10 个消费方与去向

| 文件 | 现在怎么用 | 改成 |
|---|---|---|
| `atoms/agent.ts` | 定义 atom | **R4 删除** |
| `app/(shell)/skills/page.tsx` | 按当前过滤已装技能 | **R1** 主从：页面本地选中 Agent |
| `home/launcher-home.tsx` | 新会话 agentId 来源 | **R2** Agent 下拉选中 |
| `im/new-message-view.tsx` | 新会话 agentId | **R2** 同起手台的选择 |
| `shell/assistant-sidebar.tsx` | onSelect/resolve/defaultOpen | **R3** 去当前，列全部 |
| `agent/agent-editor-sheet.tsx` | 建/删切当前 | **R3** 不切当前（无当前态） |
| `im/assistant-dock.tsx` | 快捷问 agentId | **R3** 落默认 Agent（传 undefined） |
| `session/assistant-conversation-body.tsx` | 产物 agentId 兜底 | **R3** 只用 session.agentId，删兜底 |
| `lib/filter-sessions-by-agent.ts` | 按当前过滤会话 | **R4 删除**（侧栏改 groupSessionsByAgent 列全部） |
| `rest/session.ts` | 新会话入参 | 保留函数签名，调用方传就地选的 agentId |

---

## Task 1：（R1）技能页主从视图（列所有 Agent → 看它的技能）

**Files:**
- Modify: `apps/web-agent/src/app/(shell)/skills/page.tsx`
- Modify/Create: `apps/web-agent/src/components/skills/skills-sidebar.tsx`（或在页面内加 Agent 列）
- Test: 若抽纯函数则加 spec

**Interfaces:**
- Consumes: `useAgents()`（`rest/agents.ts`，已在用）；`fetchInstalled(agentId)`（`rest/skills.ts`，已接受 agentId）
- Produces: 技能页不再读 `currentAgentIdAtom`；页面本地 state `selectedAgentId`

- [ ] **Step 1: 读现状**

读 `skills/page.tsx` 全文 + `SkillsSidebar`（现在是 installed/market 视图切换）。确认 `fetchInstalled(agentId?)` / `installSkill` / `uninstallSkill` / `publishSkill` 都接受 agentId 参数（Task 4/12 加的）。

- [ ] **Step 2: 改成主从**

- 页面本地 state：`const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)`。
- `const { data: agents } = useAgents();` 首个 agent 默认选中：`useEffect(() => { if (!selectedAgentId && agents?.length) setSelectedAgentId(agents[0].id); }, [agents, selectedAgentId]);`
- 左侧（或 SkillsSidebar 上方）列**所有 Agent**（含零技能的），点击设 `selectedAgentId`，当前选中高亮（这是**页面本地**的选中，不是全局）。用 `parseAgentAvatar` 渲染头像。
- `reloadInstalled` 的 `fetchInstalled(currentAgentId ?? undefined)` → `fetchInstalled(selectedAgentId ?? undefined)`；effect 依赖 `[selectedAgentId]`。
- install/uninstall/publish 也传 `selectedAgentId`。
- 右侧标题显示「<选中 Agent 名> 的技能」让归属可见（解决初版「看不出在看谁的技能」的缺口）。

删掉 `import { currentAgentIdAtom }`。

- [ ] **Step 3: 验证**
```bash
pnpm --filter @meshbot/web-agent typecheck && npx jest apps/web-agent
```
Expected: 无回归；技能页不再引 currentAgentIdAtom（`grep currentAgentId app/(shell)/skills/page.tsx` 应为空）。手工冒烟：列出所有 Agent，点不同 Agent 右侧技能跟着换。

- [ ] **Step 4: Commit**
```bash
git add -A && git commit -m "feat(web-agent): 技能页改主从——列所有 Agent，点选看它的技能（去当前态）"
```

---

## Task 2：（R2）起手台 + 新建会话改「选本机 Agent」

**Files:**
- Modify: `apps/web-agent/src/components/home/launcher-home.tsx`
- Modify: `apps/web-agent/src/components/home/composer-target-bar.tsx`（设备选择器 → Agent 下拉）
- Modify: `apps/web-agent/src/components/im/new-message-view.tsx`（若也建会话）

**Interfaces:**
- Consumes: `useAgents()`；新建本地会话的 REST（现有 `createSession`/`rest/session.ts`，接受 agentId）
- Produces: 起手台目标选择器 = 本机 Agent 扁平下拉；选中 Agent → 新会话归它。不读 `currentAgentIdAtom`

- [ ] **Step 1: 读现状**

读 `launcher-home.tsx`（现在用 `ComposerTargetBar` + `selectedDeviceId` + `sendToRemoteDevice`/本地 createSession 分支）和 `composer-target-bar.tsx`。搞清「本地 createSession」这条路怎么走、agentId 现在从哪来（`currentAgentId ?? undefined`）。

- [ ] **Step 2: 目标选择器改 Agent 下拉**

- `composer-target-bar.tsx`：把「设备下拉」改成「本机 Agent 下拉」——选项直接是 `useAgents()` 的各 Agent（扁平，头像+名字），本地 state `selectedAgentId`。**远程设备/跨设备发送这条路（`sendToRemoteDevice`）2a 先保留现状**（2c 再统一成远程 Agent）——如果 target bar 现在同时管本地+远程，2a 只把「本地目标」从「本机设备」换成「本机 Agent 下拉」，远程设备项保持（或先隐藏，二选一，在报告说明你的选择与理由）。
- `launcher-home.tsx`：本地发送分支的 agentId 来源从 `currentAgentId ?? undefined` 改成 `selectedAgentId ?? undefined`（选了就用，没选后端兜底默认——**别传空串**）。
- `new-message-view.tsx`：同理，建会话的 agentId 来自就地选择或 undefined，不读全局 atom。

删掉这些文件的 `currentAgentIdAtom` import。

- [ ] **Step 3: 验证**
```bash
pnpm --filter @meshbot/web-agent typecheck && npx jest apps/web-agent
```
手工冒烟：起手台目标下拉列出本机 Agent；选 Agent A 发一条 → 新会话在 A 下（侧栏 A 节点出现）；选 B → 在 B 下。

- [ ] **Step 4: Commit**
```bash
git add -A && git commit -m "feat(web-agent): 起手台目标改「选本机 Agent」下拉；新建会话归选中 Agent（去当前态）"
```

---

## Task 3：（R3）侧栏去当前 + 剩余消费方迁移

**Files:**
- Modify: `apps/web-agent/src/components/shell/assistant-sidebar.tsx`
- Modify: `packages/web-common/src/session/session-tree.tsx`（移除 onSelectAgent，可选）
- Modify: `apps/web-agent/src/components/agent/agent-editor-sheet.tsx`
- Modify: `apps/web-agent/src/components/im/assistant-dock.tsx`
- Modify: `apps/web-agent/src/components/session/assistant-conversation-body.tsx`

**Interfaces:**
- Consumes: `groupSessionsByAgent`（已有）；`useAgents()`
- Produces: 侧栏并列列出所有 Agent→会话，无当前态无高亮；剩余消费方不读 `currentAgentIdAtom`

- [ ] **Step 1: 侧栏去当前**

`assistant-sidebar.tsx`：
- 删 `currentAgentId` / `setCurrentAgentId` / `onSelectAgent` / `resolveCurrentAgentId` effect。
- 上区仍用 `groupSessionsByAgent(agents, allSessions)` 列**所有** Agent→会话（本来就列全部）。
- `defaultOpen`：不再按 currentAgentId。改为「含当前 URL 会话的那个 Agent 自动展开」（`containsActiveSession`，这条初版已有）；其余折叠。
- Agent 行点击：只展开/收起（NavItem 默认行为），不设当前、不高亮。
- 顶部「新建任务」CTA 仍进起手台（起手台现在自己选 Agent）。

- [ ] **Step 2: SessionTree 移除 onSelectAgent（可选，若无其他消费方）**

grep 确认 `onSelectAgent` 除侧栏外无消费方 → 从 `session-tree.tsx` 的 `SessionTreeProps` + `AgentRow` 移除（web-common 改动，跑 web-common test + web-main typecheck）。若嫌动 web-common，也可留着不传（未用的可选 prop 无害）——二选一，报告说明。

- [ ] **Step 3: 编辑抽屉去当前切换**

`agent-editor-sheet.tsx`：删除 Agent 后不再 `setCurrentAgentId(nextSelectedAgentId(...))`（无当前态）。删除逻辑简化为：删该 Agent；若当前打开的会话属于被删 Agent，导航走（`router.push("/assistant")` 或首页）。不读/写 `currentAgentIdAtom`。`nextSelectedAgentId` 若因此无消费方 → R4 删。

- [ ] **Step 4: dock + 会话体**

- `assistant-dock.tsx`：快捷问会话落**默认 Agent**——建会话/产物 agentId 传 `undefined`（后端 `resolveOrDefault` 兜底默认），删 `currentAgentIdAtom`。
- `assistant-conversation-body.tsx`：产物 agentId **只用 `session.agentId`**（Task 12 已是主路径），删掉 `?? currentAgentId` 兜底那截，删 import。

- [ ] **Step 5: 验证**
```bash
pnpm --filter @meshbot/web-agent typecheck && npx jest apps/web-agent && pnpm check
```
（若动了 web-common：先 `pnpm --filter @meshbot/web-common build` 再 `pnpm --filter @meshbot/web-main typecheck`。）
手工冒烟：侧栏列出所有 Agent，点 Agent 只展开、无高亮；刷新停在某会话 → 它所属 Agent 自动展开；删无关 Agent 不影响当前打开的会话。

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "feat(web-agent): 侧栏去当前态（列全部 Agent 无高亮）+ dock/会话体/编辑抽屉去 currentAgentId"
```

---

## Task 4：（R4）删除 currentAgentIdAtom + 死代码清理 + 终验

**Files:**
- Delete: `apps/web-agent/src/atoms/agent.ts`（若只剩这个 atom）
- Delete: `apps/web-agent/src/lib/filter-sessions-by-agent.ts`（+spec，侧栏改 groupSessionsByAgent 后无消费方）
- Delete: `apps/web-agent/src/lib/resolve-current-agent.ts`（+spec，无消费方）
- Delete: `apps/web-agent/src/lib/next-selected-agent-id.ts`（+spec，删除逻辑简化后无消费方）
- Modify: 任何残留 import

- [ ] **Step 1: 确认零消费方**
```bash
grep -rn "currentAgentIdAtom\|filterSessionsByAgent\|resolveCurrentAgentId\|nextSelectedAgentId" apps/web-agent/src --include='*.ts' --include='*.tsx' | grep -v spec
```
Expected: 只剩定义处自身（R1-R3 已迁完所有消费）。若还有消费方 → 回去补迁，别硬删。

- [ ] **Step 2: 删除**

`git rm` 上面确认无消费的文件（及其 spec）。`atoms/agent.ts` 若只含 `currentAgentIdAtom` 则整删；若还有别的导出则只删该 atom。

- [ ] **Step 3: 终验**
```bash
pnpm --filter @meshbot/web-agent typecheck
npx jest apps/web-agent
pnpm --filter @meshbot/web-common test
pnpm typecheck
pnpm check
pnpm --filter @meshbot/web-agent build
```
Expected：全绿；`grep -rn currentAgentId apps/web-agent/src` 为空（彻底删净）。读完整输出。

- [ ] **Step 4: 手工冒烟清单（交用户真机）**
1. 起手台目标下拉列出本机 Agent；选 A/B 发起 → 会话各归各的 Agent。
2. 技能页左列所有 Agent，点不同 Agent 右侧技能跟着换；给 A 装技能，点 B 是空的。
3. 侧栏并列列出所有 Agent→会话，点 Agent 只展开无高亮；刷新停某会话 → 所属 Agent 自动展开。
4. 编辑/删除 Agent 正常；删无关 Agent 不影响当前会话。
5. 全程没有任何「全局当前 Agent」的痕迹。

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "refactor(web-agent): 删除 currentAgentIdAtom 及配套死代码——去全局当前 Agent 收官"
```

---

## 交付后的状态

Agent 是并列的组织维度：起手台选 Agent 发起、技能页主从看各 Agent 技能、侧栏并列列出所有 Agent→会话，没有全局当前态。计划一后端 + 2a 复用部分（SessionTree agent kind / 编辑抽屉 / 会话头）全部保留。

**不做**（2b/2c）：云端注册、agentId 寻址、远程 Agent、web-main IA。起手台的远程设备/跨设备发送保持现状，2c 统一成远程 Agent。
