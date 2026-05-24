# 会话标题自动生成 设计

## 目标

新建会话后异步用 LLM 生成更友好的标题（而非「首条前 30 字」的机械截断），
通过 socket 实时推送给前端 sidebar，且不影响主对话流式。

## 范围

**做：**
- 后端 sessions 表加 `title_generated` 标记位 + migration
- 新 `SessionTitleService`：fire-and-forget 入队 + 调 LLM + 写库 + emit 事件
- `SessionService.patchIfNotGenerated`（条件 update 保证 race 安全）+ 现有
  `patch({ title })` 改为同步 mark `titleGenerated=true`
- `GraphService.getModel()` 暴露 cached chat model，让 title service 复用
- WebSocket: `session.title_updated` 事件 + namespace 广播
- 前端 `updateSessionTitleAtom` 局部 patch + AppShell 订阅 socket
- prompt 复用 PromptService：新增 `session-title.md`，代码内置 fallback

**不做：**
- 「切会话发现 titleGenerated=false 自动重试生成」—— 用户已确认仅手动重试场景，
  未来加「重生成标题」菜单时再说
- 后台失败自动重试（fire-and-forget + log warn）
- 「首条 + 首轮 assistant 回复后再生成」（语义更准但太复杂）
- 每隔 N 轮重生成
- 单独的 title 模型配置字段（复用 enabled model）

## 数据模型

### Entity 改动

`apps/server-agent/src/entities/session.entity.ts` 增列：

```ts
@Column({ name: "title_generated", type: "boolean", default: false })
titleGenerated!: boolean;
```

语义：「title 是 LLM 生成的 **或** 用户明确改过」—— 用一个字段同时挡住
LLM 改名（防覆盖用户修改）和未来「重生成菜单」的判断。

### Migration

`apps/server-agent/src/migrations/1779500000000-AddSessionsTitleGenerated.ts`：

```sql
ALTER TABLE sessions ADD COLUMN title_generated INTEGER NOT NULL DEFAULT 0;
```

SQLite 没原生 boolean，TypeORM 用 INTEGER 0/1 序列化。`down` 同上一个迁移
理由：不支持 DROP COLUMN，留列即可。

### SessionSummary

`libs/types-agent/src/session.ts` 加字段：

```ts
export const SessionSummarySchema = z.object({
  // ... 现有字段
  titleGenerated: z.boolean(),
});
```

list / patch / create 三处返回随之带上。前端 atom 一并加。

## 后端

### `SessionService` 改动

`patch({ title })` 同步 mark `titleGenerated=true`：

```ts
if (input.title !== undefined) {
  changes.title = input.title;
  changes.titleGenerated = true;
}
```

新增条件 update：

```ts
/**
 * 仅在 titleGenerated 仍为 false 时把 title 写入并 mark generated=true。
 * 用户已手动改名时返回 null，调用方丢弃结果。单 update + WHERE 三件套
 * 保证原子，无需事务。
 */
async patchIfNotGenerated(
  sessionId: string,
  title: string,
): Promise<SessionSummary | null> {
  const res = await this.sessionRepo.update(
    { id: sessionId, titleGenerated: false },
    { title, titleGenerated: true },
  );
  if (!res.affected) return null;
  const s = await this.findSessionOrFail(sessionId);
  return toSummary(s);
}
```

`createSession` 不变（title 仍 = content.slice(0, 30), titleGenerated 默认 false）。

### `GraphService.getModel`

```ts
/** 暴露给 SessionTitleService 等非 graph 流程复用同一 chat model（带 cache）。 */
async getModel(): Promise<BaseChatModel> {
  return this.resolveModel();
}
```

### `SessionTitleService`（新）

`apps/server-agent/src/services/session-title.service.ts`：

```ts
import { GraphService } from "@meshbot/agent";
import { PromptService } from "@meshbot/agent/prompt/prompt.service";
import { type SessionTitleUpdatedEvent, SESSION_WS_EVENTS }
  from "@meshbot/types-agent";
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SessionService } from "./session.service";

const TITLE_MAX = 30;

/** Prompt 模板未定义时的 fallback —— 让 dev 环境不依赖 prompt 文件铺设。 */
const FALLBACK_PROMPT =
  "You are a chat title generator. Given the first user message of a " +
  "conversation, write a concise 5–15 character (CJK or English) title " +
  "summarizing the topic.\n\n" +
  "Rules:\n" +
  "- Output ONLY the title text; no quotes, no punctuation, no prefix.\n" +
  "- Use the same language as the user message.\n" +
  "- No emoji unless the user message itself is mostly emoji.\n\n" +
  "User message:\n{{content}}";

@Injectable()
export class SessionTitleService {
  private readonly logger = new Logger(SessionTitleService.name);

  constructor(
    private readonly graph: GraphService,
    private readonly sessions: SessionService,
    private readonly prompt: PromptService,
    private readonly emitter: EventEmitter2,
  ) {}

  /** fire-and-forget 入队。setImmediate 让 controller 立即 return。 */
  schedule(sessionId: string, firstMessageContent: string): void {
    setImmediate(() => {
      this.generate(sessionId, firstMessageContent).catch((err) => {
        this.logger.warn(
          `session-title 生成失败 session=${sessionId}：${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  private async generate(sessionId: string, content: string): Promise<void> {
    // 1) 早早 short-circuit：开始前先看 titleGenerated（用户已改名就别浪费 LLM）
    const cur = await this.sessions.findSessionOrFail(sessionId);
    if (cur.titleGenerated) return;

    // 2) 调 LLM
    const model = await this.graph.getModel();
    const promptText = this.buildPrompt(content);
    const res = await model.invoke(promptText);
    const raw = typeof res.content === "string" ? res.content : "";
    const title = sanitizeTitle(raw);
    if (!title) {
      this.logger.warn(`session-title LLM 返回空 session=${sessionId}`);
      return;
    }

    // 3) 写库前再次条件 update（LLM 调用期间用户可能改名）
    const updated = await this.sessions.patchIfNotGenerated(sessionId, title);
    if (!updated) return; // 用户改名了，丢弃结果

    // 4) emit ws 事件 → gateway 广播 → 前端 atom 局部更新
    this.emitter.emit(SESSION_WS_EVENTS.titleUpdated, {
      sessionId,
      title: updated.title,
    } satisfies SessionTitleUpdatedEvent);
  }

  private buildPrompt(content: string): string {
    const template = this.prompt.getPrompt("session-title") ?? FALLBACK_PROMPT;
    return template.replace("{{content}}", content);
  }
}

/**
 * 清洗 LLM 输出 —— trim、去引号、单行、硬截 30 字。
 * 空串返空串（调用方判空决定是否写库）。
 */
function sanitizeTitle(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  // 剥首尾常见引号
  s = s.replace(/^[`'"「『《]+/, "").replace(/[`'"」』》]+$/, "");
  s = s.trim();
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX);
  return s;
}
```

### `SessionController.create` 触发

```ts
@Post()
async create(@Body() dto: CreateSessionDto): Promise<CreateSessionResponse> {
  const result = await this.sessions.createSession(dto);
  this.runner.kick(result.sessionId);
  this.titleService.schedule(result.sessionId, dto.content);
  return result;
}
```

### `SessionModule` 注册

`SessionTitleService` 加进 `providers` 和 `exports`，并把 `PromptService`
保证可被 inject（已在 AgentModule 暴露 / 通过 GraphService 间接依赖，确认时
若 DI 解析不到则在 SessionModule 显式 import）。

## WebSocket

### types-agent 加事件常量 + schema

```ts
export const SessionTitleUpdatedEventSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
});
export type SessionTitleUpdatedEvent = z.infer<
  typeof SessionTitleUpdatedEventSchema
>;

// SESSION_WS_EVENTS
titleUpdated: "session.title_updated",
```

### Gateway 转发

```ts
@OnEvent(SESSION_WS_EVENTS.titleUpdated)
onTitleUpdated(payload: SessionTitleUpdatedEvent): void {
  this.server.emit(SESSION_WS_EVENTS.titleUpdated, payload);
}
```

**注意**：用 `server.emit`（namespace-wide broadcast），不用 `server.to(room).emit`
—— sidebar 不需要 subscribe 任何 session room 也能收到。本地轨单用户场景下
namespace 所有 socket 都是同一人，安全。

## 前端

### atom

`apps/web-agent/src/atoms/sessions.ts` 加：

```ts
/**
 * 按 id 局部 patch session title + titleGenerated=true。
 * socket session.title_updated 收到 + 未来「重生成标题」入口共用。
 */
export const updateSessionTitleAtom = atom(
  null,
  (get, set, params: { id: string; title: string }) => {
    const arr = get(sessionsAtom);
    if (!arr.some((s) => s.id === params.id)) return;
    set(
      sessionsAtom,
      sortSessions(
        arr.map((s) =>
          s.id === params.id
            ? { ...s, title: params.title, titleGenerated: true }
            : s,
        ),
      ),
    );
  },
);
```

### AppShell 订阅

`apps/web-agent/src/components/layouts/app-shell-layout.tsx` 已有 `useEffect`
跑 `loadSessions`，紧旁边追加：

```ts
const updateSessionTitle = useSetAtom(updateSessionTitleAtom);

useEffect(() => {
  const socket = getSessionSocket();
  const onTitleUpdated = (e: SessionTitleUpdatedEvent) => {
    updateSessionTitle({ id: e.sessionId, title: e.title });
  };
  socket.on(SESSION_WS_EVENTS.titleUpdated, onTitleUpdated);
  return () => {
    socket.off(SESSION_WS_EVENTS.titleUpdated, onTitleUpdated);
  };
}, [updateSessionTitle]);
```

### Session 页：无改动

title 是 sidebar 维度，session 页内部不显示 session.title，不参与。

## Prompt 文件

`<meshbotDir>/prompt/session-title.md`（**实施时不创建**，靠 FALLBACK_PROMPT 兜底；
未来用户想自定义时手动放）。

## 失败 / Race 处理

| 场景 | 行为 |
|---|---|
| LLM 抛错 | catch 只 log；title/titleGenerated 不变（保留首条 30 字 + false） |
| LLM 返回空 | 不写库 + log warn |
| LLM 返回带引号/换行 | sanitizeTitle 清洗 |
| LLM 返回 > 30 字 | 硬截 30 |
| 调用前用户改名 | 入口 `if (cur.titleGenerated) return` 直接放弃 |
| 调用中用户改名 | 写库 patchIfNotGenerated 条件 update 返 null，丢弃结果 |
| 多 session 并发创建 | setImmediate fire-and-forget，互不干扰；模型并发由 model provider 自己处理 |

## 测试

### SessionTitleService 单测

- LLM 返清晰 title → 写库 + emit 事件
- LLM 返空 → 不写库 + 不 emit
- LLM 返带引号 → sanitizeTitle 清洗
- 入口已 titleGenerated=true → 不调 LLM
- LLM 期间外部 mark titleGenerated=true → patchIfNotGenerated 返 null → 不 emit
- LLM 抛错 → schedule 不抛、log warn

### SessionService.patchIfNotGenerated 单测

- titleGenerated=false → update 生效，返 SessionSummary
- titleGenerated=true → 不动数据，返 null

### SessionService.patch 测试更新

- patch({ title }) 后 titleGenerated 也变 true

### 其他

- types-agent: SessionSummarySchema 加 titleGenerated 字段后旧测试若有 fixture
  需补字段

## 不变量

- title 字段长度 ≤ 30
- `titleGenerated=true` 后 title 不会再被自动覆盖
- socket `session.title_updated` 事件 emit 前数据已落库（先 update 再 emit）
- 标题任务失败不影响主对话 run

## 未来扩展

- 「重生成标题」菜单项 → SessionTitleService 加一个 public `regenerate()`
  方法（绕过 titleGenerated 检查），DropdownMenu 加入口
- 多语言 prompt 文件（`session-title.zh.md` / `.en.md`），按用户语言选
- model_configs 加 title_model_id 字段允许指定便宜模型
