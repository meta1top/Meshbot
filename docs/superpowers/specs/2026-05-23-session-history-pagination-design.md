# 会话历史分页与上拉加载

## 背景

当前 `GET /api/sessions/:id/history` 从 LangGraph SQLite checkpointer 一次性返回 `graph.getState().values.messages` —— 这是 **graph state**，即 LLM 的输入 context。两个问题在 session 越聊越长时会暴露：

1. **性能**：checkpointer 把整个 messages 数组当一个 BLOB 存。一次 getState 反序列化全部消息，N 增长后明显卡顿。LangGraph 没有按消息粒度的查询 API，无法在 checkpointer 上做真分页。
2. **语义错位**：未来引入 LLM 上下文压缩（`RemoveMessage` + summarize）后，checkpointer 里的老消息会被裁掉。但**用户展示的历史应永久保留**，与 LLM 上下文是两件事。

## 决策

新增展示用 `session_messages` 表，**append-only**、永不删；Runner 在写 checkpointer 的同时双写此表。展示历史走该表（支持真分页），LLM context 仍由 LangGraph state 管。

历史接口改为 cursor 分页：默认返回最新 50 条 + hasMore；前端滚动到顶部哨兵触发拉更早消息。

老会话不迁移（用户测试用新会话即可）。

## 表结构

`apps/server-agent/src/entities/session-message.entity.ts`：

```ts
@Entity({ name: "session_messages" })
export class SessionMessage {
  /** 与 checkpointer HumanMessage.id / AIMessage.id 对齐；user 消息也是 pending_messages.id。 */
  @PrimaryColumn() id: string;

  @Column({ name: "session_id" }) sessionId: string;

  /** "user" | "assistant" | "system" | "tool"；本次仅 user/assistant 写入，tool 预留。 */
  @Column() role: string;

  @Column({ type: "text" }) content: string;

  /** 推理模型的思考过程（DeepSeek 等）；非推理 / 工具消息为 null。 */
  @Column({ type: "text", nullable: true }) reasoning: string | null;

  /** 工具调用参数（JSON-string），assistant 调工具时填；本次预留。 */
  @Column({ name: "tool_calls", type: "text", nullable: true }) toolCalls: string | null;

  /** tool role 时关联到上游 assistant 的某条 tool_call id；本次预留。 */
  @Column({ name: "tool_call_id", nullable: true }) toolCallId: string | null;

  @Column({ name: "created_at", type: "datetime" }) createdAt: Date;
}
```

索引：

- 主键 `id`（用于幂等 INSERT、按 id 查 cursor 的 createdAt 锚点）
- 复合 `(session_id, created_at, id)` —— cursor 翻页查询 + 顺序排序

本地轨 SQLite 走 `synchronize: true`（与现有 pending_messages 等表一致）。

## 写入时机

`RunnerService.runOnce` 已有 `for await (const event of stream)`：

- `event.kind === "human"`：emit `run.human` 后调 `void this.sessionMessages.recordUser({...})`
- `event.kind === "reasoning"`：在 run 局部状态里累积 `run.reasoning += event.delta`（runOnce 增加 reasoning 字段，与现有 content 并列）
- stream 结束（success path）：emit `run.done` 后调 `void this.sessionMessages.recordAssistant({ id: run.messageId, sessionId, content: run.content, reasoning: run.reasoning || null })`
- 失败/中断路径：**不写**（assistant 可能内容不完整或为空）

双写 fail-safe：写失败仅 `logger.error`，不抛、不中断 run。这条权衡的代价是数据可能漏写一条；用户重发即可。比阻塞 LLM 流可接受。

## Service 层

`apps/server-agent/src/services/session-message.service.ts`（新文件）：

```ts
@Injectable()
export class SessionMessageService {
  constructor(
    @InjectRepository(SessionMessage)
    private readonly repo: Repository<SessionMessage>,
  ) {}

  /**
   * 记录一条 user 消息。幂等：id 主键冲突视为已存在，吞掉错误。
   * 单表写入，无需事务。
   */
  async recordUser(input: {
    id: string;
    sessionId: string;
    content: string;
  }): Promise<void>;

  /**
   * 记录一条 assistant 消息（含 reasoning）。幂等。
   * 单表写入，无需事务。
   */
  async recordAssistant(input: {
    id: string;
    sessionId: string;
    content: string;
    reasoning: string | null;
  }): Promise<void>;

  /**
   * Cursor 分页：返回 sessionId 下早于 beforeMessageId 的最新 limit 条
   * （按 createdAt asc 排，前端按时间顺序展示）。
   *
   * 实现：先按 id 拿 before 锚点的 createdAt（若 before 给了），再
   * `WHERE sessionId AND createdAt < anchor ORDER BY createdAt DESC LIMIT (limit + 1)`，
   * 取 limit 条 + 用 limit+1 条判 hasMore。最后把数组 reverse 回 asc。
   *
   * before 未传 → 最新 limit 条。
   * before 指向不属于该 session 的 id → NotFoundException。
   */
  async listPage(
    sessionId: string,
    opts: { before?: string; limit: number },
  ): Promise<{ messages: SessionMessage[]; hasMore: boolean }>;
}
```

幂等实现：用 `pendingRepo.insert(...).orIgnore()` 或 try/catch UNIQUE constraint。优先 `repo.upsert(row, ['id'])`（TypeORM），失败兜底 `findOneBy + 不存在再 insert`。具体实现细节交给实施。

`SessionMessageService` 通过 `TxTypeOrmModule.forFeature([SessionMessage])` 注册到 SessionAgentModule。

## API 改造

### 路由保持不变

`GET /api/sessions/:id/history`

### 查询参数（新增）

- `before?: string` — 上一批最早消息的 id（cursor）。不传 = 拉最新一批
- `limit?: number` — 每页条数，默认 50，硬上限 200（防滥用）

### 响应 schema

```ts
{
  messages: HistoryMessage[],     // 按 createdAt asc
  hasMore: boolean,                // true 表示还有更早消息可拉
  inflight: InflightSnapshot | null,   // 仅首次（before 未传）填，翻页时为 null
  // 仅首次（before 未传）返
  sessionTotals?: SessionTotals,
  // 每次都返：本批 messages 对应的 usage 子集
  byMessage: Record<string, MessageUsage>,
}
```

`HistoryResponseSchema` 修订对应字段（在 `libs/types-agent/src/session.ts` 改）。

### Controller 改写

`SessionController.history`：

1. 解析 `before` 与 `limit`（用 NestJS `@Query` 装饰器 + Zod 验证或 ParseIntPipe）
2. 调 `sessionMessages.listPage(sessionId, { before, limit })`
3. 如果 `before` 未传：额外调 `runner.getInflight(sessionId)` + `llmCalls.getSessionTotals(sessionId)`，并返回 `inflight + sessionTotals`
4. 调 `llmCalls.listByMessageIds(messages.map(m => m.id))` 拿本批 usage（LlmCallService 新增此方法）

### `graph.getHistory` 废弃路径

不删除 `GraphService.getHistory` —— 它可能在 LLM 调试场景有用；但 controller 不再调它。

## LlmCallService 增量

新增 `listByMessageIds(messageIds: string[]): Promise<LlmCall[]>`。
查询：`WHERE message_id IN (...)`。

## 前端

### `apps/web-agent/src/rest/session.ts`

```ts
export async function fetchHistory(
  sessionId: string,
  before?: string,
): Promise<HistoryResponse>
```

`apiClient.get` URL 拼上 `?before=...&limit=50`（before 缺省时省略）。

### `apps/web-agent/src/app/session/page.tsx`

#### State

- 新增 `oldestMessageIdRef = useRef<string | null>(null)`：跟踪当前 messages 顶部消息的 id，作为下次翻页的 cursor
- 新增 `hasMoreHistoryRef = useRef(true)`：服务端 hasMore 缓存
- 新增 `loadingMoreRef = useRef(false)`：防止哨兵 intersect 重入

#### 初次加载

`fetchHistory(sessionId)` 不传 before。把 messages 注入数组、记录 oldestMessageIdRef = messages[0]?.id、hasMoreHistoryRef = hasMore。

#### 翻页加载

新增 `loadMoreHistory` callback：

```ts
const loadMoreHistory = useCallback(async () => {
  if (!sessionId || !hasMoreHistoryRef.current || loadingMoreRef.current) return;
  const cursor = oldestMessageIdRef.current;
  if (!cursor) return;
  loadingMoreRef.current = true;
  try {
    // 翻页前记录滚动容器的 scrollHeight（用于锚定视口）
    const scroller = scrollContainerRef.current;
    const prevScrollHeight = scroller?.scrollHeight ?? 0;
    const prevScrollTop = scroller?.scrollTop ?? 0;

    const res = await fetchHistory(sessionId, cursor);
    apply((prev) => {
      const newMessages: TimelineMessage[] = res.messages.map(/* ... */);
      // 去重：socket 抢先到的消息可能已在数组里
      const existingIds = new Set(prev.map((m) => m.id));
      const fresh = newMessages.filter((m) => !existingIds.has(m.id));
      return [...fresh, ...prev];
    });
    appendUsageByMessage(res.byMessage);  // 新 atom action
    oldestMessageIdRef.current = res.messages[0]?.id ?? cursor;
    hasMoreHistoryRef.current = res.hasMore;

    // prepend 完成后，恢复视口位置（保持用户当前看的消息不动）
    requestAnimationFrame(() => {
      if (!scroller) return;
      const newScrollHeight = scroller.scrollHeight;
      scroller.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
    });
  } catch (err) {
    console.error("加载更早消息失败", err);
  } finally {
    loadingMoreRef.current = false;
  }
}, [sessionId, apply, appendUsageByMessage]);
```

#### 哨兵 + IntersectionObserver

`MessageList` 之上加一个 `<div ref={topSentinelRef}>`（仅 hasMore 时渲染）。

`useEffect` 注册 IO：

```ts
useEffect(() => {
  if (!hasMoreHistoryRef.current) return;
  const sentinel = topSentinelRef.current;
  if (!sentinel) return;
  const io = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) loadMoreHistory();
    },
    { rootMargin: "100px" },  // 滚到距顶 100px 提前触发
  );
  io.observe(sentinel);
  return () => io.disconnect();
}, [loadMoreHistory, hasMoreHistory]);  // hasMoreHistory 用 state 镜像 ref 触发重建
```

> 实施提示：IO callback 里读 ref 即可，不需要把 hasMoreHistory 提到 state 强制重渲。但 useEffect deps 仍要写 `loadMoreHistory`，且哨兵从有到无需要 cleanup。可以用 state `[hasMoreHistory, setHasMoreHistory]` 与 ref 双写。

#### Usage atom 调整

`appendUsageAtom` / `setInitialUsageAtom` 已存在。新增（或改用现有）`appendUsageByMessageAtom`，参数 `Record<string, MessageUsage>`，合并到现有 record（覆盖语义 OK，同 id 不该重复）。

`sessionTotals` 仍然只在首次加载时设。

#### 滚动容器

需要拿到滚动容器引用以实现锚定。当前 page 的滚动容器是哪个元素？可能是 `AppShellLayout` 内的主区域。需要把 ref 透传或在 page 内部 wrap 一个 div 作滚动容器。**实施时检查**：

- 若 body/html 滚动 → 用 `window` 或 `document.documentElement` 替代 scroller
- 若 AppShellLayout 内有 overflow-y-auto 容器 → 暴露 ref

## 类型 schema 变更

`libs/types-agent/src/session.ts`：

```ts
// 历史消息加 reasoning / role 已有；保持
// 新增：

export const HistoryQuerySchema = z.object({
  before: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
});
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

// 改造 HistoryResponseSchema
export const HistoryResponseSchema = z.object({
  messages: z.array(HistoryMessageSchema),
  hasMore: z.boolean(),
  inflight: InflightSnapshotSchema.nullable(),
  sessionTotals: SessionTotalsSchema.optional(),
  byMessage: z.record(z.string(), MessageUsageSchema),
});
```

`SessionUsageSchema` 不再嵌套；前端读响应时直接合并 `byMessage`、按需读 `sessionTotals`。

## 测试

### Service 测试 `session-message.service.spec.ts`

- recordUser 写入成功 + 重复 id 不抛、不重写
- recordAssistant 同理
- listPage 无 before → 返最新 limit 条 + hasMore（数据库准备 limit+1 条数据验真）
- listPage 有 before → 早于 before 的 limit 条
- listPage limit > 实际剩余 → hasMore=false
- listPage before 指向不属于 sessionId 的 id → NotFoundException

### 不动 runner test（fire-and-forget 写入不影响 run 完成度）

### 前端手测

- 老会话发若干消息至超 50 条
- 刷新页面：默认只渲染最后 50 条
- 滚到顶 → 自动加载更早 50 条，视口锚在用户当前看的消息位置不跳
- 滚到全部加载完 → 哨兵消失，顶部显示「会话开头」
- 加载失败 → console 报错（toast 不在范围）

## 边界 / 非目标

- **不迁移老会话**：现有 checkpointer 数据不导入；用户用新会话测试
- **不做 SSR / 服务端流式分页**：纯前端拉 + IO 触发
- **toast 错误提示**：仍是 alert / console；toast 跨多个 feature 都依赖，单独立项再做
- **summarize 不在本范围**：但表结构兼容 —— LLM context 压缩时 session_messages 不受影响
- **tool 消息字段（toolCalls / toolCallId）预留不写**：工具调用是后续 feature

## 涉及文件

| 层 | 文件 | 改动 |
|---|---|---|
| entity | `apps/server-agent/src/entities/session-message.entity.ts` | 新增 |
| service | `apps/server-agent/src/services/session-message.service.ts` | 新增 |
| service | `apps/server-agent/src/services/runner.service.ts` | 双写 + run.reasoning 累积 |
| service | `apps/server-agent/src/services/llm-call.service.ts` | 加 listByMessageIds |
| controller | `apps/server-agent/src/controllers/session.controller.ts` | history 改 cursor + 新响应形 |
| module | `apps/server-agent/src/app.module.ts`（或对应 sub-module） | 注册 SessionMessage entity + service |
| types | `libs/types-agent/src/session.ts` | HistoryQuerySchema + HistoryResponse 重塑 |
| client | `apps/web-agent/src/rest/session.ts` | fetchHistory 加 before 参数 |
| page | `apps/web-agent/src/app/session/page.tsx` | refs + loadMoreHistory + IO 哨兵 + 锚定 |
| atom | `apps/web-agent/src/atoms/session-usage.ts` | byMessage 合并 action |
| test | `apps/server-agent/src/services/session-message.service.spec.ts` | 新增 |
