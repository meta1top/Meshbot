# 侧边栏会话列表（list / pin / rename / delete）设计

## 目标

把侧边栏当前写死的 mockup（「最近」+「已固定」两段）替换为真实的会话列表，
支持固定、重命名、删除、一次性全量加载 + 局部状态维护。

## 范围

**做：**
- 后端：sessions 表加 `pinned_at` 列；新增 list / patch / delete 端点；
  改 create 接口返回完整 SessionSummary。
- 前端：删除写死 mockup；新增 sidebar/session-list-* 组件；
  Jotai atom 单一 source of truth + 乐观更新 + 客户端排序；
  内联重命名；AlertDialog 删除确认；首屏骨架屏。
- i18n 文案：`recents` → `sessions`，配套中英文。

**不做：**
- 不动顶部「新会话 / 计划任务」两项。
- 不做分页 / 虚拟列表（YAGNI，会话上千前不需要）。
- 不做 LLM 自动生成标题（留 atom 接口，下期工程）。
- 不做 drag-to-pin 拖拽重排（pinnedAt 字段已为此预留）。

## 后端

### Entity

`apps/server-agent/src/entities/session.entity.ts` 增列：

```ts
@Column({ name: "pinned_at", type: "datetime", nullable: true })
pinnedAt!: Date | null;
```

单字段 `pinnedAt` 同时承担「是否固定」（非 null）+「固定顺序」（值）。
不引入 `pinned: boolean + pinOrder: number` 两字段：状态分散、易不一致，
未来 drag-to-pin 只需更新 `pinnedAt` 即可重排。

### Migration

`apps/server-agent/src/migrations/1779400000000-AddSessionsPinnedAt.ts`：

```sql
ALTER TABLE sessions ADD COLUMN pinned_at datetime;
CREATE INDEX idx_sessions_pinned_at_updated_at
  ON sessions (pinned_at, updated_at);
```

### REST 端点

| 方法 路径 | 用途 | 返回 |
|---|---|---|
| `GET    /api/sessions`           | 全量列表（已排序） | `{ sessions: SessionSummary[] }` |
| `POST   /api/sessions` *(改)*    | 创建（kick run） | `{ sessionId, session: SessionSummary }` |
| `PATCH  /api/sessions/:id`       | 改 title / pin   | `SessionSummary` |
| `DELETE /api/sessions/:id`       | 硬删 + 级联       | `{ deleted: true }` |

`POST` 的返回兼容：保留原有 `sessionId` 字段不变（其他调用方仍可读），
追加 `session` 字段。

### SessionSummary

```ts
export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["idle", "running"]),
  pinned: z.boolean(),                    // 派生：pinnedAt != null
  pinnedAt: z.string().nullable(),        // ISO；客户端排序需要
  createdAt: z.string(),
  updatedAt: z.string(),
});
```

放 `libs/types-agent/src/schemas/session.ts`，与现有 `SessionStatus` 同模块。

### List 排序 SQL

```sql
SELECT * FROM sessions
ORDER BY
  CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END,
  pinned_at  DESC,
  updated_at DESC,
  id         DESC;
```

`id DESC` 作 tie-breaker（参考 session_messages.listPage 的同款做法），
避免同毫秒下顺序漂移。

### PATCH body

```ts
export const SessionPatchSchema = z.object({
  title:  z.string().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
}).refine(d => d.title !== undefined || d.pinned !== undefined, {
  message: "至少传 title 或 pinned 之一",
});
```

行为：
- `title` 直接更新。
- `pinned: true`  → `pinnedAt = new Date()`。
- `pinned: false` → `pinnedAt = null`。
- 同时传则一起更新。

### Delete 级联

`SessionService.deleteSession(sessionId)`，`@Transactional()`：

1. 若 runner 当前在跑该 session → `runner.interrupt(sessionId)`（不等待，
   后端事务直接进行；inflight 进程下次 await 会因 abort 退出，不持有 DB 锁）。
2. `DELETE FROM llm_calls         WHERE session_id = ?`
3. `DELETE FROM session_messages  WHERE session_id = ?`
4. `DELETE FROM pending_messages  WHERE session_id = ?`
5. checkpointer：调 `langgraph-checkpoint-sqlite` 的 `deleteThread` 若存在；
   否则手动 `DELETE FROM checkpoints WHERE thread_id = ?` +
   `DELETE FROM writes WHERE thread_id = ?`（表名以 0.1.x 实际为准，
   实现时验证；若变更则封装到 `CheckpointerCleanup.deleteThread`）。
6. `DELETE FROM sessions WHERE id = ?`

Repository 访问遵守 check:repo 规范：每个表通过其归属 Service 删除
（llm_calls → LlmCallService、session_messages → SessionMessageService、
pending_messages / sessions → SessionService）。事务上下文自动透传。

## 前端

### Atoms

`apps/web-agent/src/state/sessions.atoms.ts`：

```ts
export type SessionsStatus = "idle" | "loading" | "loaded" | "error";

export const sessionsAtom        = atom<SessionSummary[]>([]);
export const sessionsStatusAtom  = atom<SessionsStatus>("idle");

// 派生
export const pinnedSessionsAtom  = atom(get => /* filter pinned */);
export const recentSessionsAtom  = atom(get => /* filter !pinned */);

// 异步操作（writable atoms）
export const loadSessionsAtom    = atom(null, async (_, set) => { /* ... */ });
export const addSessionAtom      = atom(null, (get, set, s: SessionSummary) => { /* unshift + sort */ });
export const renameSessionAtom   = atom(null, async (get, set, { id, title }) => { /* optimistic + rollback */ });
export const togglePinAtom       = atom(null, async (get, set, { id, pinned }) => { /* optimistic + rollback */ });
export const deleteSessionAtom   = atom(null, async (get, set, id) => { /* optimistic + rollback */ });
```

### 客户端排序（与后端 SQL 等价）

```ts
function sortSessions(arr: SessionSummary[]): SessionSummary[] {
  return [...arr].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) return cmpDateDesc(a.pinnedAt!, b.pinnedAt!);
    return cmpDateDesc(a.updatedAt, b.updatedAt);
  });
}
```

任何写 atom 后调一次 `sortSessions` 重排。`addSessionAtom` 不依赖 unshift 顺序，
而是 push 后排序 —— 这样 pinned 的新会话也会落到正确位置。

### 失败回滚

乐观更新：先在 atom 里改，再调 API；API 失败则把原值 set 回去 + toast。

### 创会话流程

`useCreateSession`（或现有等价 hook）：

```ts
const res = await api.post('/api/sessions', { ... });
addSessionAtom(res.session);
router.push(`/session/${res.sessionId}`);
```

### 文件结构

```
apps/web-agent/src/components/sidebar/
├── session-list-section.tsx     // 标题 + 子项列表
├── session-list-item.tsx        // 单条（默认/编辑/激活 三态）
├── session-list-skeleton.tsx    // 首屏骨架（6 条 pulse 方块）
└── session-delete-dialog.tsx    // shadcn AlertDialog
```

`app-shell-layout.tsx` 把现有「已固定 / 最近」两段写死 markup 替换为：

```tsx
{status === 'loading' && <SessionListSkeleton />}
{status === 'loaded' && (
  <>
    {pinned.length > 0 && (
      <SessionListSection title={t('pinned')} sessions={pinned} />
    )}
    <SessionListSection title={t('sessions')} sessions={recent} />
  </>
)}
{status === 'error' && (
  <div className="px-2 py-1 text-xs text-destructive">
    会话加载失败 <button onClick={retry}>重试</button>
  </div>
)}
```

mount 时调 `loadSessionsAtom`，仅当 `status === 'idle'` 才触发首次拉取，
之后任何操作走局部 patch，永不再回 `loading`。

### SessionListItem 三态

| 态 | 显示 | 触发 |
|---|---|---|
| 默认 | MessageSquare 图标 + 标题 truncate + 三点（hover 显） | 默认 |
| 编辑 | MessageSquare 图标 + Input（autofocus + 全选） | 菜单「修改标题」 |
| 激活 | 同默认 + active 高亮（复用 SidebarNavItem 样式） | 路由匹配 |

- 三点菜单：shadcn `DropdownMenu`，三项「修改标题」「固定/取消固定」「删除」
- 编辑 Input：
  - Enter 保存 + 退出编辑（IME composition 期 Enter 忽略，参考现有 ChatInput 的
    `isComposing || keyCode === 229` 判断）
  - Esc 取消
  - blur 保存
  - 空标题 / 与原值相同 → 不发请求，退出编辑
- 编辑态隐藏菜单触发器（避免 hover 冲突）

### 删除 Dialog

shadcn `AlertDialog`：

```
标题：删除会话「{title}」？
描述：此会话内所有消息及记录将被永久删除，不可恢复。
按钮：[取消]  [删除]（destructive variant）
```

确认后：
1. `deleteSessionAtom(id)` 乐观从列表移除。
2. 若 `usePathname()` 解析的当前 session id === 被删 id → `router.push('/')`。
3. API 失败则回滚（toast + 把会话插回原位）。

### 骨架屏

```tsx
<div className="mt-1 space-y-0.5">
  {Array.from({ length: 6 }).map((_, i) => (
    <div key={i} className="h-7 w-full bg-foreground/5 animate-pulse" />
  ))}
</div>
```

只在「会话」分组下显示，不为 pinned 渲染骨架（pinned 默认隐藏）。

### i18n

`messages/en.json` / `messages/zh.json`：

| key | 现在 | 改为 |
|---|---|---|
| `appShell.recents` | "Recent" / "最近" | "Sessions" / "会话" |
| `appShell.pinned`  | 不变 | 不变 |
| `appShell.dragToPin` | 删（本期没有 drag-to-pin 入口） | — |
| `appShell.sessions.menu.rename` | 新增 | "Rename" / "修改标题" |
| `appShell.sessions.menu.pin`    | 新增 | "Pin" / "固定" |
| `appShell.sessions.menu.unpin`  | 新增 | "Unpin" / "取消固定" |
| `appShell.sessions.menu.delete` | 新增 | "Delete" / "删除" |
| `appShell.sessions.deleteConfirm.title` | 新增 | "Delete session \"{title}\"?" / "删除会话「{title}」？" |
| `appShell.sessions.deleteConfirm.description` | 新增 | "All messages and records in this session will be permanently deleted." / "此会话内所有消息及记录将被永久删除，不可恢复。" |
| `appShell.sessions.deleteConfirm.cancel` | 新增 | "Cancel" / "取消" |
| `appShell.sessions.deleteConfirm.confirm` | 新增 | "Delete" / "删除" |
| `appShell.sessions.loadFailed` | 新增 | "Failed to load sessions" / "会话加载失败" |
| `common.retry` | 复用（如有）/ 新增 | "Retry" / "重试" |

旧的「添加插件市场插件 / 回复用户问候」mockup 文案随静态 markup 一起删，
i18n key 删掉避免悬空。

## 错误处理

- 列表加载失败：inline 「会话加载失败 [重试]」一行，重试调 `loadSessionsAtom`。
- 单条 rename/pin/delete 失败：toast + 回滚。
- 删除当前会话失败：toast，不跳转。

## 不变量

- 同一 `sessionId` 在 `sessionsAtom` 里至多一条。
- 排序结果与后端 SQL 等价（pinned 优先 → pinned_at desc → updated_at desc → id desc）。
- 列表加载完成（status='loaded'）后永不回 'loading'：任何后续变化都走局部 patch。

## 未来扩展（不在本期）

- LLM 自动生成 / 改写标题：调 `updateSessionTitleAtom({ id, title })` 局部 patch。
- drag-to-pin 重排：UI 上拖动更新 `pinnedAt = new Date()` 即可推到顶。
- 会话搜索：在 `sessionsAtom` 之上做 client-side filter。
- 分页 / 虚拟列表：会话破千时再上 react-virtuoso。
