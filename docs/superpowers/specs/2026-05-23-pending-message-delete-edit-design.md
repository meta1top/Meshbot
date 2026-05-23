# Pending 消息删除与编辑

## 背景

会话页 pending 区已显示 `status === "pending"` 的 user 消息（runner 未 claim），右侧预留了编辑/删除按钮位但回调仅 console.warn。本设计补齐后端接口与前端交互。

会话页架构：
- 前端发消息时生成 UUID 作 `messageId`，POST `/api/sessions/:sid/messages` 写 `pending_messages` 表（status=pending）+ runner kick 消费
- runner `claimPending` 把整批 pending 原子转 processing，发 `run.human` 通知前端把对应气泡迁出 pending 区
- pending 区显示约束：`pendingRepo` 行的 status 必须严格是 `"pending"`，processing/failed 不属此区

## 用户故事

- 我在 pending 区看到一条还没轮到的消息，鼠标 hover 出现垃圾桶图标，点一下消息从队列消失
- 我看到自己拼写错了想改，点编辑图标，消息内容回到输入框，pending 队列里消失了，我修改后重新发
- 删除/编辑期间按钮变 loading 不能重复点
- 如果删除/编辑时 runner 刚好接管这条消息（status 已变 processing），前端提示「已开始处理，无法删除/编辑」并刷新列表

## 范围

仅作用于 `status === "pending"` 的消息。`processing` / `failed` / `processed` 返回 409。

## 后端

### 新接口

`DELETE /api/sessions/:sessionId/pending-messages/:messageId`

- 鉴权：与现有 session 接口一致（沿用 SessionController 装饰器栈）
- 路径参数：sessionId、messageId 都是 UUID 字符串
- 响应 200：
  ```json
  { "deleted": true, "content": "<原消息内容>" }
  ```
- 响应 404：消息不存在（包括跨 session 越权访问 —— 把它一并当 404 处理，不暴露存在性）
- 响应 409：消息存在且属于该 session，但 status ≠ pending

返回 content 是为了**编辑**场景由前端回填输入框；删除场景前端可丢弃。

### Service 层

`SessionService` 新增：

```ts
async deletePendingMessage(
  sessionId: string,
  messageId: string,
): Promise<{ content: string }>
```

实现要点：
- 单表读+删，**无需 `@Transactional`**（单写动作 + 单读）
- 流程：
  1. `pendingRepo.findOneBy({ id: messageId, sessionId })`
     - null → 抛 `NotFoundException`
  2. 若 `row.status !== "pending"` → 抛 `ConflictException("消息已开始处理")`
  3. `pendingRepo.delete({ id: messageId, sessionId, status: "pending" })`
     - 用三件套 WHERE 防止「读到 pending → delete 之间 runner claim」的窗口：
       若 `affected === 0` → 抛 `ConflictException`
  4. 返回 `{ content: row.content }`

为什么不省略步骤 1、2 直接靠步骤 3 的 affected：
- 区分 404 vs 409 需要先 find
- 这种"读后写"在单表+单进程下不会引入额外问题；步骤 3 的 WHERE 保证原子性

### 错误码

新增两个 error code（如果走项目 `defineErrorCode` 体系）：
- `SESSION.PENDING_NOT_FOUND` → 404
- `SESSION.PENDING_NOT_PENDING` → 409

或复用 Nest 内置 `NotFoundException` / `ConflictException`（与 `findSessionOrFail` 风格保持一致；现状是直接 throw NotFoundException）。**采用后者，与现有风格一致**。

### Repository 归属

`pendingRepo` 已归属 `SessionService`，新方法继续放此处。不引入新的 Repository 注入点。

### 单元测试

`session.service.spec.ts` 新增：

- 删 status=pending 成功返回 content，记录从表中消失
- 删 status=processing → ConflictException
- 删 status=failed → ConflictException
- 删 status=processed → ConflictException
- 不存在的 messageId → NotFoundException
- 跨 session 删（同 messageId 但传错 sessionId）→ NotFoundException（不暴露存在性）

## 前端

### REST client

`apps/web-agent/src/rest/session.ts` 新增：

```ts
interface DeletePendingPayload {
  deleted: true;
  content: string;
}

export async function deletePendingMessage(
  sessionId: string,
  messageId: string,
): Promise<DeletePendingPayload>
```

`DELETE` via `apiClient.delete<DeletePendingPayload>`。

### Types

`libs/types-agent/src/session.ts` 新增 `DeletePendingResponseSchema`（与上述 payload 同形）+ 类型导出。

### ChatInput 受控化

当前 ChatInput 自管 `value` 状态。改为受控：
- Props 新增 `value: string` + `onChange: (next: string) => void`
- 移除内部 `useState<string>("")`，所有读改走 props.value
- 发送成功后由 `props.onChange("")` 清空（不再内部 setValue("")）

两处调用方（[apps/web-agent/src/app/page.tsx](apps/web-agent/src/app/page.tsx) 首页、[apps/web-agent/src/app/session/page.tsx](apps/web-agent/src/app/session/page.tsx) 会话页）各自添加 `const [draft, setDraft] = useState("")` + 传入。

### PendingList

新增 props（替代当前占位 `onDelete/onEdit`）：

```ts
interface PendingListProps {
  messages: TimelineMessage[];
  onDelete: (id: string) => Promise<void>;
  onEdit: (id: string, content: string) => Promise<void>;
}
```

内部维护 `inFlightIds: Set<string>`：
- 点击进入 inFlight → 两个按钮 `disabled` + 垃圾桶/铅笔图标换成转圈 loading
- onDelete/onEdit 是 async，await 完成后从 inFlightIds 移除（无论成败）
- 失败时由父组件 toast，PendingList 本身不显示错误状态

### 会话页（page.tsx）

新增 handler：

```ts
const handleDeletePending = useCallback(async (id: string) => {
  try {
    await deletePendingMessage(sessionId, id);
    apply((prev) => prev.filter((m) => m.id !== id));
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      toast.error("消息已开始处理，无法删除");
      // 触发 fetchPending 重拉同步真相
      // refetchPending 不是现有 hook，需要把 page.tsx 当前的 useEffect 内联
      // fetchPending 提取为可调用函数。或者更简单：依赖 onHuman 自然推动状态收敛
      // —— 该消息既已 processing，runner 必然 emit run.human，前端会自动迁出。
      // 实施时优先后者（不引入 refetchPending），仅在不可行时回到前者。
    } else if (err.response?.status === 404) {
      toast.error("该消息已不存在");
      apply((prev) => prev.filter((m) => m.id !== id));
    } else {
      toast.error("网络错误,请重试");
    }
  }
}, [sessionId, apply]);

const handleEditPending = useCallback(async (id: string) => {
  if (draft.trim() && !window.confirm("覆盖当前输入框内容?")) return;
  try {
    const { content } = await deletePendingMessage(sessionId, id);
    apply((prev) => prev.filter((m) => m.id !== id));
    setDraft(content);
    chatInputRef.current?.focus();
  } catch (err) {
    // 同 handleDeletePending 错误处理
  }
}, [sessionId, draft, apply]);
```

注意：`handleEditPending` 调的就是 `deletePendingMessage`,只是用了返回的 content。编辑 = 删 + 填回。

**focus 支持**:ChatInput 通过 ref 暴露 `focus()` 方法(useImperativeHandle),page.tsx 持有 ref。

### Toast 系统

项目当前是否已有 toast?

需要补查 (`grep sonner|toast|notify`)。若无,先用 `console.error` + 简单的 `alert` 占位,后续接入 sonner / 自建 toast 组件。**spec 假设走 toast,实施时按现状降级**。

### 数据流总览

```
[删除]
点击 → PendingList 进入 inFlight(id) → DELETE → 
  200: page.apply 移除 + inFlight 退出
  409: toast + refetchPending + inFlight 退出
  404: toast + apply 移除 + inFlight 退出
  err: toast + inFlight 退出

[编辑]
点击 → draft 非空 confirm → PendingList inFlight(id) → DELETE →
  200: page.apply 移除 + setDraft(content) + chatInputRef.focus() + inFlight 退出
  409/404/err: 同上,不灌 draft
```

## 边界 / 已知非目标

- **不实现「跨设备同步删除」**:本地轨单用户,无须广播 socket 事件
- **不实现 undo**:删除是终态
- **编辑后保留 messageId**:不,前端走 handleSend 的新流程 → 新 UUID。原 messageId 已从 pending 表移除,checkpointer 里也不会有(messageId 仅在 claim → graph yield human 时才写入)
- **首页 ChatInput 受控化**:虽与本需求无直接关系,但 ChatInput 改受控涉及所有调用方,首页一起改

## 测试

### 后端
- `session.service.spec.ts` 6 个用例(见 Service 层)
- (可选) `session.controller.spec.ts` 走 supertest 验 404/409/200 状态码

### 前端
- 手测路径:
  1. 发 3 条消息(连发),第 1 条进 processing,第 2/3 条 pending
  2. 删第 3 条 → 列表少一条;第 2 条仍 pending
  3. 编辑第 2 条 → pending 区空,输入框出现「第 2 条内容」+ focus
  4. 修改后发送 → 走正常发送流程,生成新 messageId

### 边界手测
- 在 runner 即将 claim 时狂点删除 → 偶发 409,toast 显示

## 涉及文件

| 层 | 文件 | 改动 |
|---|---|---|
| types-agent | `libs/types-agent/src/session.ts` | 加 `DeletePendingResponseSchema` |
| server-agent | `apps/server-agent/src/controllers/session.controller.ts` | `@Delete(":id/pending-messages/:messageId")` |
| server-agent | `apps/server-agent/src/services/session.service.ts` | `deletePendingMessage` |
| server-agent | `apps/server-agent/src/services/session.service.spec.ts` | 6 个新测试 |
| web-agent | `apps/web-agent/src/rest/session.ts` | `deletePendingMessage` client |
| web-agent | `apps/web-agent/src/components/common/chat-input.tsx` | 改受控 + 暴露 `focus()` ref |
| web-agent | `apps/web-agent/src/components/session/pending-list.tsx` | inFlightIds + async 回调 |
| web-agent | `apps/web-agent/src/app/session/page.tsx` | draft state + handleDelete/Edit |
| web-agent | `apps/web-agent/src/app/page.tsx` | draft state + 传给 ChatInput |
