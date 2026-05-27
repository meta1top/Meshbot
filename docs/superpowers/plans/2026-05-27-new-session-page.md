# 新会话页（首页）优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 web-agent 首页加 logo + 随机标题、把 mock 指标换成真实 stats（带时间筛选）、在输入框上方加基于历史会话标题生成的 AI 行动建议胶囊。

**Architecture:** 后端新增两个只读端点 `GET /api/stats?range=` 与 `GET /api/suggestions`，由新 `StatsService`/`SuggestionService` 组合现有归属 Service（`SessionService` / `SessionMessageService` / `LlmCallService`）的聚合方法实现，遵守 check:repo（不跨实体注入 Repository）。建议复用 `SessionTitleService` 的一次性 `getTitleModel().invoke()` 模式 + 内存缓存。前端首页接两个端点，logo 走 public 静态资源，随机标题客户端挂载后选取避免 hydration mismatch。

**Tech Stack:** NestJS + TypeORM(better-sqlite3) + Zod(`@meshbot/types-agent`) + Jest；Next.js + Jotai + next-intl + axios(`@meshbot/web-common`)。

---

## File Structure

**新建：**
- `libs/types-agent/src/stats.ts` — stats / suggestions 的 Zod schema + 类型
- `apps/server-agent/src/services/stats.util.ts` — 纯函数（range→since、本地日期、连续天数、高峰小时）
- `apps/server-agent/src/services/stats.util.spec.ts`
- `apps/server-agent/src/services/stats.service.ts` — 组合聚合
- `apps/server-agent/src/services/stats.service.spec.ts`
- `apps/server-agent/src/services/suggestion.util.ts` — 纯函数（解析 LLM 输出）
- `apps/server-agent/src/services/suggestion.util.spec.ts`
- `apps/server-agent/src/services/suggestion.service.ts` — 取标题 + 缓存 + LLM
- `apps/server-agent/src/services/suggestion.service.spec.ts`
- `apps/server-agent/src/controllers/stats.controller.ts`
- `apps/server-agent/src/controllers/suggestion.controller.ts`
- `apps/web-agent/public/logo.svg` — 从 src/assets 复制
- `apps/web-agent/src/rest/stats.ts` — fetchStats / fetchSuggestions
- `apps/web-agent/src/lib/format-stats.ts` — formatPeakHour / formatStreak
- `apps/web-agent/src/components/common/suggestion-chips.tsx`

**修改：**
- `libs/types-agent/src/index.ts` — 导出 stats
- `apps/server-agent/src/services/session.service.ts` — 加 `countCreatedSince`
- `apps/server-agent/src/services/session-message.service.ts` — 加 `activitySince`
- `apps/server-agent/src/services/llm-call.service.ts` — 加 `sumTotalTokensSince` / `topModelSince`
- `apps/server-agent/src/session.module.ts` — 注册新 Service + Controller
- `apps/web-agent/messages/zh.json` + `en.json` — 加 `home.titles` / `home.defaultSuggestions`
- `apps/web-agent/src/app/page.tsx` — logo + 随机标题 + 真实 stats + range toggle + chips

---

## Task 1: types-agent — stats / suggestions schema

**Files:**
- Create: `libs/types-agent/src/stats.ts`
- Modify: `libs/types-agent/src/index.ts`

- [ ] **Step 1: 写 schema 文件**

`libs/types-agent/src/stats.ts`:
```typescript
import { z } from "zod";

/** 首页 stats 时间范围。 */
export const StatsRangeSchema = z.enum(["all", "30d", "7d"]);
export type StatsRange = z.infer<typeof StatsRangeSchema>;

/** GET /api/stats query。range 缺省 all。 */
export const StatsQuerySchema = z.object({
  range: StatsRangeSchema.default("all"),
});
export type StatsQuery = z.infer<typeof StatsQuerySchema>;

/** 热力图单元格：某天的消息计数。 */
export const HeatmapCellSchema = z.object({
  date: z.string(), // YYYY-MM-DD（本地时区）
  count: z.number().int().nonnegative(),
});
export type HeatmapCell = z.infer<typeof HeatmapCellSchema>;

/** GET /api/stats 响应。 */
export const StatsResponseSchema = z.object({
  sessions: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  activeDays: z.number().int().nonnegative(),
  currentStreak: z.number().int().nonnegative(),
  longestStreak: z.number().int().nonnegative(),
  peakHour: z.number().int().min(0).max(23).nullable(),
  favoriteModel: z.string().nullable(),
  heatmap: z.array(HeatmapCellSchema),
});
export type StatsResponse = z.infer<typeof StatsResponseSchema>;

/** GET /api/suggestions 响应。 */
export const SuggestionsResponseSchema = z.object({
  suggestions: z.array(z.string()),
});
export type SuggestionsResponse = z.infer<typeof SuggestionsResponseSchema>;
```

- [ ] **Step 2: 导出**

在 `libs/types-agent/src/index.ts` 末尾追加：
```typescript
export * from "./stats";
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck --filter=@meshbot/types-agent`
Expected: 通过，无类型错误。

- [ ] **Step 4: Commit**

```bash
git add libs/types-agent/src/stats.ts libs/types-agent/src/index.ts
git commit -m "feat(types-agent): 加首页 stats / suggestions schema"
```

---

## Task 2: stats.util 纯函数 + 单测

**Files:**
- Create: `apps/server-agent/src/services/stats.util.ts`
- Test: `apps/server-agent/src/services/stats.util.spec.ts`

- [ ] **Step 1: 写失败的测试**

`apps/server-agent/src/services/stats.util.spec.ts`:
```typescript
import {
  computeStreaks,
  localDateKey,
  pickPeakHour,
  rangeToSince,
} from "./stats.util";

describe("stats.util", () => {
  it("rangeToSince: all 返回 null；7d/30d 返回 now 往前 N 天", () => {
    const now = new Date("2026-05-27T10:00:00Z");
    expect(rangeToSince("all", now)).toBeNull();
    expect(rangeToSince("7d", now)?.toISOString()).toBe(
      new Date("2026-05-20T10:00:00Z").toISOString(),
    );
    expect(rangeToSince("30d", now)?.toISOString()).toBe(
      new Date("2026-04-27T10:00:00Z").toISOString(),
    );
  });

  it("localDateKey: 本地 YYYY-MM-DD", () => {
    const d = new Date(2026, 4, 7, 23, 30); // 本地 5/7
    expect(localDateKey(d)).toBe("2026-05-07");
  });

  it("computeStreaks: current 从今天往前数连续，longest 取全局最长", () => {
    const dates = ["2026-05-25", "2026-05-26", "2026-05-27", "2026-05-20"];
    expect(computeStreaks(dates, "2026-05-27")).toEqual({
      current: 3,
      longest: 3,
    });
  });

  it("computeStreaks: 今天无活动则 current=0", () => {
    const dates = ["2026-05-24", "2026-05-25"];
    expect(computeStreaks(dates, "2026-05-27")).toEqual({
      current: 0,
      longest: 2,
    });
  });

  it("computeStreaks: 空集合返回 0/0", () => {
    expect(computeStreaks([], "2026-05-27")).toEqual({ current: 0, longest: 0 });
  });

  it("pickPeakHour: 取计数最大的小时；全 0 返回 null", () => {
    const byHour = Array.from({ length: 24 }, () => 0);
    expect(pickPeakHour(byHour)).toBeNull();
    byHour[18] = 5;
    byHour[9] = 3;
    expect(pickPeakHour(byHour)).toBe(18);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- stats.util`
Expected: FAIL（`Cannot find module './stats.util'`）。

- [ ] **Step 3: 实现**

`apps/server-agent/src/services/stats.util.ts`:
```typescript
import type { StatsRange } from "@meshbot/types-agent";

/** range → 起始时间（含）。"all" 返回 null（无下界）。 */
export function rangeToSince(range: StatsRange, now: Date): Date | null {
  if (range === "all") return null;
  const days = range === "7d" ? 7 : 30;
  const since = new Date(now);
  since.setDate(since.getDate() - days);
  return since;
}

/** 本地日期 YYYY-MM-DD。 */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateKey: string, delta: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return localDateKey(dt);
}

/**
 * 从活跃日期集合算连续天数。
 * - current：从 today 往前数的连续活跃天数（today 无活动则为 0）
 * - longest：任意位置的最长连续活跃天数
 */
export function computeStreaks(
  activeDates: string[],
  today: string,
): { current: number; longest: number } {
  const set = new Set(activeDates);
  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = d;
  }
  let current = 0;
  let cursor = today;
  while (set.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  return { current, longest };
}

/** 取消息最多的小时（0–23）；全 0 返回 null。 */
export function pickPeakHour(byHour: number[]): number | null {
  let best = -1;
  let bestCount = 0;
  for (let h = 0; h < byHour.length; h++) {
    if (byHour[h] > bestCount) {
      bestCount = byHour[h];
      best = h;
    }
  }
  return best < 0 ? null : best;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- stats.util`
Expected: PASS（6 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add apps/server-agent/src/services/stats.util.ts apps/server-agent/src/services/stats.util.spec.ts
git commit -m "feat(server-agent): stats 纯函数（range/streak/peakHour）+ 单测"
```

---

## Task 3: 三个归属 Service 加聚合方法 + 单测

**Files:**
- Modify: `apps/server-agent/src/services/session.service.ts`
- Modify: `apps/server-agent/src/services/session-message.service.ts`
- Modify: `apps/server-agent/src/services/llm-call.service.ts`
- Test: `apps/server-agent/src/services/stats-aggregates.spec.ts`

> 说明：聚合方法是单表只读查询，**不需要** `@Transactional()`，方法名也无需命中事务命名约定（非私有 `@Transactional` 方法）。SQLite 时间分桶用 `strftime(..., 'localtime')` 对齐本地时区。

- [ ] **Step 1: 写失败的测试**

`apps/server-agent/src/services/stats-aggregates.spec.ts`:
```typescript
import { DataSource } from "typeorm";
import { LlmCall } from "../entities/llm-call.entity";
import { Session } from "../entities/session.entity";
import { SessionMessage } from "../entities/session-message.entity";
import { LlmCallService } from "./llm-call.service";
import { SessionMessageService } from "./session-message.service";

describe("stats 聚合方法", () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [Session, SessionMessage, LlmCall],
      synchronize: true,
    });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("SessionMessageService.activitySince 按本地日/小时分桶", async () => {
    const repo = ds.getRepository(SessionMessage);
    await repo.insert([
      { id: "m1", sessionId: "s1", role: "user", content: "a", reasoning: null, toolCalls: null, toolCallId: null, metadata: null, createdAt: new Date(2026, 4, 27, 18, 0) },
      { id: "m2", sessionId: "s1", role: "assistant", content: "b", reasoning: null, toolCalls: null, toolCallId: null, metadata: null, createdAt: new Date(2026, 4, 27, 18, 30) },
      { id: "m3", sessionId: "s1", role: "user", content: "c", reasoning: null, toolCalls: null, toolCallId: null, metadata: null, createdAt: new Date(2026, 4, 26, 9, 0) },
    ]);
    const svc = new SessionMessageService(repo);
    const r = await svc.activitySince(null);
    expect(r.total).toBe(3);
    expect(r.byDate).toEqual([
      { date: "2026-05-26", count: 1 },
      { date: "2026-05-27", count: 2 },
    ]);
    expect(r.byHour[18]).toBe(2);
    expect(r.byHour[9]).toBe(1);
  });

  it("LlmCallService.sumTotalTokensSince / topModelSince", async () => {
    const repo = ds.getRepository(LlmCall);
    await repo.insert([
      { sessionId: "s1", messageId: "m1", providerType: "openai", model: "gpt-4o", inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, durationMs: 100, createdAt: new Date(2026, 4, 27, 18, 0) },
      { sessionId: "s1", messageId: "m2", providerType: "openai", model: "gpt-4o", inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, durationMs: 100, createdAt: new Date(2026, 4, 27, 18, 5) },
      { sessionId: "s1", messageId: "m3", providerType: "anthropic", model: "claude", inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, durationMs: 100, createdAt: new Date(2026, 4, 27, 18, 10) },
    ]);
    const svc = new LlmCallService(repo);
    expect(await svc.sumTotalTokensSince(null)).toBe(47);
    expect(await svc.topModelSince(null)).toBe("gpt-4o");
  });

  it("空库：sum=0 / topModel=null / activity 全空", async () => {
    const mSvc = new SessionMessageService(ds.getRepository(SessionMessage));
    const lSvc = new LlmCallService(ds.getRepository(LlmCall));
    const a = await mSvc.activitySince(null);
    expect(a).toEqual({ total: 0, byDate: [], byHour: Array.from({ length: 24 }, () => 0) });
    expect(await lSvc.sumTotalTokensSince(null)).toBe(0);
    expect(await lSvc.topModelSince(null)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- stats-aggregates`
Expected: FAIL（`activitySince is not a function` 等）。

- [ ] **Step 3: 给 SessionMessageService 加方法**

在 `apps/server-agent/src/services/session-message.service.ts` 类内追加（确保文件顶部从 `@meshbot/types-agent` import 了 `HeatmapCell`，若没有则加 `import type { HeatmapCell } from "@meshbot/types-agent";`）：
```typescript
  /**
   * 范围内消息活跃度聚合：总数 + 按本地日分桶（热力图/活跃天/连续天数来源）
   * + 按本地小时分桶（高峰时段来源）。since 为 null 表示全部。
   */
  async activitySince(
    since: Date | null,
  ): Promise<{ total: number; byDate: HeatmapCell[]; byHour: number[] }> {
    const base = () => {
      const qb = this.repo.createQueryBuilder("m");
      if (since) {
        qb.where("datetime(m.created_at) >= datetime(:since)", {
          since: since.toISOString(),
        });
      }
      return qb;
    };
    const total = await base().getCount();
    const dayRows = await base()
      .select("strftime('%Y-%m-%d', m.created_at, 'localtime')", "date")
      .addSelect("COUNT(*)", "count")
      .groupBy("date")
      .orderBy("date", "ASC")
      .getRawMany<{ date: string; count: number | string }>();
    const byDate: HeatmapCell[] = dayRows.map((r) => ({
      date: r.date,
      count: Number(r.count),
    }));
    const hourRows = await base()
      .select("CAST(strftime('%H', m.created_at, 'localtime') AS INTEGER)", "hour")
      .addSelect("COUNT(*)", "count")
      .groupBy("hour")
      .getRawMany<{ hour: number | string; count: number | string }>();
    const byHour = Array.from({ length: 24 }, () => 0);
    for (const r of hourRows) byHour[Number(r.hour)] = Number(r.count);
    return { total, byDate, byHour };
  }
```

- [ ] **Step 4: 给 LlmCallService 加方法**

在 `apps/server-agent/src/services/llm-call.service.ts` 类内追加：
```typescript
  /** 范围内 total_tokens 求和。since 为 null 表示全部。 */
  async sumTotalTokensSince(since: Date | null): Promise<number> {
    const qb = this.llmCallRepo
      .createQueryBuilder("c")
      .select("COALESCE(SUM(c.total_tokens), 0)", "sum");
    if (since) {
      qb.where("datetime(c.created_at) >= datetime(:since)", {
        since: since.toISOString(),
      });
    }
    const row = await qb.getRawOne<{ sum: number | string }>();
    return Number(row?.sum ?? 0);
  }

  /** 范围内出现次数最多的 model；无记录返回 null。 */
  async topModelSince(since: Date | null): Promise<string | null> {
    const qb = this.llmCallRepo
      .createQueryBuilder("c")
      .select("c.model", "model")
      .addSelect("COUNT(*)", "count")
      .groupBy("c.model")
      .orderBy("count", "DESC")
      .limit(1);
    if (since) {
      qb.where("datetime(c.created_at) >= datetime(:since)", {
        since: since.toISOString(),
      });
    }
    const row = await qb.getRawOne<{ model: string; count: number | string }>();
    return row?.model ?? null;
  }
```

- [ ] **Step 5: 给 SessionService 加方法**

在 `apps/server-agent/src/services/session.service.ts` 类内追加：
```typescript
  /** 范围内创建的会话数。since 为 null 表示全部。 */
  async countCreatedSince(since: Date | null): Promise<number> {
    const qb = this.sessionRepo.createQueryBuilder("s");
    if (since) {
      qb.where("datetime(s.created_at) >= datetime(:since)", {
        since: since.toISOString(),
      });
    }
    return qb.getCount();
  }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test -- stats-aggregates`
Expected: PASS（3 个用例全过）。

- [ ] **Step 7: Commit**

```bash
git add apps/server-agent/src/services/session.service.ts apps/server-agent/src/services/session-message.service.ts apps/server-agent/src/services/llm-call.service.ts apps/server-agent/src/services/stats-aggregates.spec.ts
git commit -m "feat(server-agent): 三个归属 Service 加 stats 聚合方法 + 单测"
```

---

## Task 4: StatsService 组合 + 单测

**Files:**
- Create: `apps/server-agent/src/services/stats.service.ts`
- Test: `apps/server-agent/src/services/stats.service.spec.ts`

- [ ] **Step 1: 写失败的测试**

`apps/server-agent/src/services/stats.service.spec.ts`:
```typescript
import type { LlmCallService } from "./llm-call.service";
import type { SessionMessageService } from "./session-message.service";
import type { SessionService } from "./session.service";
import { StatsService } from "./stats.service";

describe("StatsService", () => {
  it("组合各 Service 聚合并算 streak / peakHour / activeDays", async () => {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const todayKey = `${y}-${m}-${d}`;

    const sessions = { countCreatedSince: async () => 3 } as unknown as SessionService;
    const byHour = Array.from({ length: 24 }, () => 0);
    byHour[18] = 7;
    const sessionMessages = {
      activitySince: async () => ({
        total: 947,
        byDate: [{ date: todayKey, count: 947 }],
        byHour,
      }),
    } as unknown as SessionMessageService;
    const llmCalls = {
      sumTotalTokensSince: async () => 4200000,
      topModelSince: async () => "gpt-4o",
    } as unknown as LlmCallService;

    const svc = new StatsService(sessions, sessionMessages, llmCalls);
    const r = await svc.getStats("all");
    expect(r).toEqual({
      sessions: 3,
      messages: 947,
      totalTokens: 4200000,
      activeDays: 1,
      currentStreak: 1,
      longestStreak: 1,
      peakHour: 18,
      favoriteModel: "gpt-4o",
      heatmap: [{ date: todayKey, count: 947 }],
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- stats.service`
Expected: FAIL（`Cannot find module './stats.service'`）。

- [ ] **Step 3: 实现**

`apps/server-agent/src/services/stats.service.ts`:
```typescript
import type { StatsRange, StatsResponse } from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";
import { LlmCallService } from "./llm-call.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";
import {
  computeStreaks,
  localDateKey,
  pickPeakHour,
  rangeToSince,
} from "./stats.util";

/** 首页概览指标：组合三个归属 Service 的聚合，不直接持有任何 Repository。 */
@Injectable()
export class StatsService {
  constructor(
    private readonly sessions: SessionService,
    private readonly sessionMessages: SessionMessageService,
    private readonly llmCalls: LlmCallService,
  ) {}

  async getStats(range: StatsRange): Promise<StatsResponse> {
    const now = new Date();
    const since = rangeToSince(range, now);
    const [sessions, activity, totalTokens, favoriteModel] = await Promise.all([
      this.sessions.countCreatedSince(since),
      this.sessionMessages.activitySince(since),
      this.llmCalls.sumTotalTokensSince(since),
      this.llmCalls.topModelSince(since),
    ]);
    const { current, longest } = computeStreaks(
      activity.byDate.map((c) => c.date),
      localDateKey(now),
    );
    return {
      sessions,
      messages: activity.total,
      totalTokens,
      activeDays: activity.byDate.length,
      currentStreak: current,
      longestStreak: longest,
      peakHour: pickPeakHour(activity.byHour),
      favoriteModel,
      heatmap: activity.byDate,
    };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- stats.service`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server-agent/src/services/stats.service.ts apps/server-agent/src/services/stats.service.spec.ts
git commit -m "feat(server-agent): StatsService 组合聚合 + 单测"
```

---

## Task 5: suggestion.util 解析 + 单测

**Files:**
- Create: `apps/server-agent/src/services/suggestion.util.ts`
- Test: `apps/server-agent/src/services/suggestion.util.spec.ts`

- [ ] **Step 1: 写失败的测试**

`apps/server-agent/src/services/suggestion.util.spec.ts`:
```typescript
import { parseSuggestions } from "./suggestion.util";

describe("parseSuggestions", () => {
  it("按行切，去序号/项目符号/引号，取前 3", () => {
    const raw = `1. 继续优化 Harness
- 给 agent 域补单测
* "梳理待合并 PR"
4) 多余的一条`;
    expect(parseSuggestions(raw)).toEqual([
      "继续优化 Harness",
      "给 agent 域补单测",
      "梳理待合并 PR",
    ]);
  });

  it("空白/空行过滤；不足 3 条按实际返回", () => {
    expect(parseSuggestions("\n\n  写测试  \n\n")).toEqual(["写测试"]);
    expect(parseSuggestions("")).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- suggestion.util`
Expected: FAIL。

- [ ] **Step 3: 实现**

`apps/server-agent/src/services/suggestion.util.ts`:
```typescript
/**
 * 解析 LLM 输出为建议数组：按行切分，去掉行首序号/项目符号、首尾引号，
 * 去空行，最多取 max 条。
 */
export function parseSuggestions(raw: string, max = 3): string[] {
  return raw
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*[-*•]\s*/, "")
        .replace(/^\s*\d+[.、)]\s*/, "")
        .replace(/^["'“”]|["'“”]$/g, "")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .slice(0, max);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- suggestion.util`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server-agent/src/services/suggestion.util.ts apps/server-agent/src/services/suggestion.util.spec.ts
git commit -m "feat(server-agent): suggestion LLM 输出解析纯函数 + 单测"
```

---

## Task 6: SuggestionService（取标题 + 缓存 + LLM）+ 单测

**Files:**
- Create: `apps/server-agent/src/services/suggestion.service.ts`
- Test: `apps/server-agent/src/services/suggestion.service.spec.ts`

- [ ] **Step 1: 写失败的测试**

`apps/server-agent/src/services/suggestion.service.spec.ts`:
```typescript
import type { GraphService } from "@meshbot/agent";
import type { PromptService } from "@meshbot/agent";
import type { SessionService } from "./session.service";
import { SuggestionService } from "./suggestion.service";

function makeSessions(titles: string[]) {
  return {
    listAllSorted: async () =>
      titles.map((title, i) => ({ id: `s${i}`, title })),
  } as unknown as SessionService;
}

describe("SuggestionService", () => {
  it("无会话标题时不调 LLM，返回空数组", async () => {
    let invoked = 0;
    const graph = {
      getTitleModel: async () => ({
        invoke: async () => {
          invoked += 1;
          return { content: "x" };
        },
      }),
    } as unknown as GraphService;
    const prompt = { getPrompt: () => undefined } as unknown as PromptService;
    const svc = new SuggestionService(makeSessions([]), graph, prompt);
    expect(await svc.getSuggestions()).toEqual([]);
    expect(invoked).toBe(0);
  });

  it("有标题：调 LLM 解析 3 条；相同标题集合二次命中缓存（不再调 LLM）", async () => {
    let invoked = 0;
    const graph = {
      getTitleModel: async () => ({
        invoke: async () => {
          invoked += 1;
          return { content: "继续优化 Harness\n写测试\n梳理 PR" };
        },
      }),
    } as unknown as GraphService;
    const prompt = { getPrompt: () => undefined } as unknown as PromptService;
    const svc = new SuggestionService(makeSessions(["A", "B"]), graph, prompt);
    expect(await svc.getSuggestions()).toEqual([
      "继续优化 Harness",
      "写测试",
      "梳理 PR",
    ]);
    expect(await svc.getSuggestions()).toEqual([
      "继续优化 Harness",
      "写测试",
      "梳理 PR",
    ]);
    expect(invoked).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- suggestion.service`
Expected: FAIL（`Cannot find module './suggestion.service'`）。

- [ ] **Step 3: 实现**

`apps/server-agent/src/services/suggestion.service.ts`:
```typescript
import { createHash } from "node:crypto";
import { GraphService, PromptService } from "@meshbot/agent";
import { Injectable } from "@nestjs/common";
import { SessionService } from "./session.service";
import { parseSuggestions } from "./suggestion.util";

const TITLE_LIMIT = 20;
const MAX_SUGGESTIONS = 3;
const CACHE_TTL_MS = 30 * 60 * 1000;

/** 兜底 prompt（用户在 ~/.meshbot/prompt/next-action-suggestions.md 可覆盖）。 */
const FALLBACK_PROMPT = `下面是用户最近的会话标题（每行一条）：
{{titles}}

请基于这些主题，用与标题相同的语言，给出 3 条简短的"下一步可以做什么"建议。
要求：每条不超过 15 个字，可直接作为新任务输入；只输出 3 行，每行一条；不要编号、不要解释。`;

/**
 * 首页"下一步行动建议"：取最近 20 条会话标题为上下文，复用 title 模型一次性
 * 生成；内存缓存（key = 标题集合 hash），标题集合变化或 30 分钟 TTL 过期才重算。
 */
@Injectable()
export class SuggestionService {
  private cache: { key: string; value: string[]; expireAt: number } | null =
    null;

  constructor(
    private readonly sessions: SessionService,
    private readonly graph: GraphService,
    private readonly prompt: PromptService,
  ) {}

  async getSuggestions(): Promise<string[]> {
    const all = await this.sessions.listAllSorted();
    const titles = all
      .slice(0, TITLE_LIMIT)
      .map((s) => s.title)
      .filter((t): t is string => Boolean(t));
    if (titles.length === 0) return [];

    const key = createHash("sha1").update(titles.join("\n")).digest("hex");
    const now = Date.now();
    if (this.cache && this.cache.key === key && this.cache.expireAt > now) {
      return this.cache.value;
    }
    const value = await this.generate(titles);
    this.cache = { key, value, expireAt: now + CACHE_TTL_MS };
    return value;
  }

  private async generate(titles: string[]): Promise<string[]> {
    const template =
      this.prompt.getPrompt("next-action-suggestions") ?? FALLBACK_PROMPT;
    const promptText = template.replaceAll("{{titles}}", titles.join("\n"));
    const model = await this.graph.getTitleModel();
    const res = await model.invoke(promptText);
    const raw = typeof res.content === "string" ? res.content : "";
    return parseSuggestions(raw, MAX_SUGGESTIONS);
  }
}
```

> 注：若 `PromptService` / `GraphService` 不是从 `@meshbot/agent` 顶层导出（以 `SessionTitleService` 的 import 路径为准——它从 `@meshbot/agent` 导入 `GraphService`、`PromptService`），照搬其 import 写法。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- suggestion.service`
Expected: PASS（2 个用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/server-agent/src/services/suggestion.service.ts apps/server-agent/src/services/suggestion.service.spec.ts
git commit -m "feat(server-agent): SuggestionService（标题上下文 + 缓存 + LLM）+ 单测"
```

---

## Task 7: 两个 Controller + 模块注册

**Files:**
- Create: `apps/server-agent/src/controllers/stats.controller.ts`
- Create: `apps/server-agent/src/controllers/suggestion.controller.ts`
- Modify: `apps/server-agent/src/session.module.ts`

- [ ] **Step 1: 写 StatsController**

`apps/server-agent/src/controllers/stats.controller.ts`:
```typescript
import { StatsQuerySchema, type StatsResponse } from "@meshbot/types-agent";
import { Controller, Get, Query } from "@nestjs/common";
import { StatsService } from "../services/stats.service";

/** 首页概览指标。 */
@Controller("api/stats")
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  async getStats(
    @Query() rawQuery: Record<string, string>,
  ): Promise<StatsResponse> {
    const { range } = StatsQuerySchema.parse(rawQuery);
    return this.stats.getStats(range);
  }
}
```

- [ ] **Step 2: 写 SuggestionController**

`apps/server-agent/src/controllers/suggestion.controller.ts`:
```typescript
import type { SuggestionsResponse } from "@meshbot/types-agent";
import { Controller, Get } from "@nestjs/common";
import { SuggestionService } from "../services/suggestion.service";

/** 首页"下一步行动建议"。 */
@Controller("api/suggestions")
export class SuggestionController {
  constructor(private readonly suggestions: SuggestionService) {}

  @Get()
  async getSuggestions(): Promise<SuggestionsResponse> {
    const suggestions = await this.suggestions.getSuggestions();
    return { suggestions };
  }
}
```

- [ ] **Step 3: 注册到 session.module.ts**

在 `apps/server-agent/src/session.module.ts`：

顶部 import 区追加：
```typescript
import { StatsController } from "./controllers/stats.controller";
import { SuggestionController } from "./controllers/suggestion.controller";
import { StatsService } from "./services/stats.service";
import { SuggestionService } from "./services/suggestion.service";
```

`controllers` 数组改为：
```typescript
  controllers: [SessionController, StatsController, SuggestionController],
```

`providers` 数组追加 `StatsService, SuggestionService`（放在 `SessionTitleService` 之后即可）。

- [ ] **Step 4: typecheck + 启动冒烟**

Run: `pnpm typecheck --filter=@meshbot/server-agent`
Expected: 通过。

手动冒烟（需要 server-agent 能起）：`pnpm dev:server-agent`，另开终端：
```bash
curl -s http://localhost:3100/api/stats | head -c 400
curl -s "http://localhost:3100/api/stats?range=7d" | head -c 400
curl -s http://localhost:3100/api/suggestions | head -c 400
```
Expected: 返回 envelope `{"success":true,"data":{...}}`，stats 含 8 字段 + heatmap 数组；suggestions 含 `suggestions` 数组（空库为 `[]`）。

> 若有全局鉴权导致 401，按现有 SessionController 同款方式带 token（`Authorization: Bearer <token>`）；这两个端点鉴权策略与 `/api/sessions` 一致。

- [ ] **Step 5: Commit**

```bash
git add apps/server-agent/src/controllers/stats.controller.ts apps/server-agent/src/controllers/suggestion.controller.ts apps/server-agent/src/session.module.ts
git commit -m "feat(server-agent): /api/stats + /api/suggestions 端点 + 模块注册"
```

---

## Task 8: i18n —— 随机标题 + 默认建议（zh/en 对称）

**Files:**
- Modify: `apps/web-agent/messages/zh.json`
- Modify: `apps/web-agent/messages/en.json`

> 关键：zh/en 必须**结构对称**（`pnpm sync:locales -- --check` 按 missing/asymmetric 判定）。两边都加 `titles`（5 条）与 `defaultSuggestions`（3 条），保留原 `title` 作兜底。

- [ ] **Step 1: 改 zh.json**

把 `apps/web-agent/messages/zh.json` 的 `"home"` 块改为：
```json
  "home": {
    "title": "接下来做什么？",
    "titles": [
      "接下来做什么？",
      "今天想推进点什么？",
      "从哪里开始？",
      "有什么我能帮上忙的？",
      "准备好了吗？"
    ],
    "defaultSuggestions": [
      "帮我梳理今天的待办",
      "解释一段代码",
      "起草一份技术方案"
    ],
    "overview": "概览",
    "models": "模型",
    "all": "全部",
    "overviewMetrics": "概览指标",
    "metrics": {
      "sessions": "会话数",
      "messages": "消息数",
      "totalTokens": "总 Token",
      "activeDays": "活跃天数",
      "currentStreak": "当前连续天数",
      "longestStreak": "最长连续天数",
      "peakHour": "高峰时段",
      "favoriteModel": "常用模型"
    }
  },
```

- [ ] **Step 2: 改 en.json**

把 `apps/web-agent/messages/en.json` 的 `"home"` 块改为：
```json
  "home": {
    "title": "What's up next?",
    "titles": [
      "What's up next?",
      "What are we working on?",
      "Where shall we start?",
      "What can I help with?",
      "Ready when you are."
    ],
    "defaultSuggestions": [
      "Help me plan today's tasks",
      "Explain a snippet of code",
      "Draft a technical proposal"
    ],
    "overview": "Overview",
    "models": "Models",
    "all": "All",
    "overviewMetrics": "Overview metrics",
    "metrics": {
      "sessions": "Sessions",
      "messages": "Messages",
      "totalTokens": "Total tokens",
      "activeDays": "Active days",
      "currentStreak": "Current streak",
      "longestStreak": "Longest streak",
      "peakHour": "Peak hour",
      "favoriteModel": "Favorite model"
    }
  },
```

- [ ] **Step 3: locales 对齐检查**

Run: `pnpm sync:locales -- --check`
Expected: `Done (missing=0, asymmetric=0)`。

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "feat(web-agent): 首页随机标题 + 默认建议 i18n 文案"
```

---

## Task 9: logo 资源 + 前端 rest/stats + 格式化工具

**Files:**
- Create: `apps/web-agent/public/logo.svg`（复制）
- Create: `apps/web-agent/src/rest/stats.ts`
- Create: `apps/web-agent/src/lib/format-stats.ts`

- [ ] **Step 1: 复制 logo 到 public（用 public 引用最稳，避免 svg import 配置问题）**

Run:
```bash
cp apps/web-agent/src/assets/image/logo.svg apps/web-agent/public/logo.svg
```
Expected: `apps/web-agent/public/logo.svg` 存在。

- [ ] **Step 2: 写 rest/stats.ts**

`apps/web-agent/src/rest/stats.ts`:
```typescript
"use client";

import type {
  StatsRange,
  StatsResponse,
  SuggestionsResponse,
} from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";

/** 取首页概览指标。 */
export async function fetchStats(range: StatsRange): Promise<StatsResponse> {
  const { data } = await apiClient.get<StatsResponse>(
    `/api/stats?range=${range}`,
  );
  return data;
}

/** 取"下一步行动建议"。 */
export async function fetchSuggestions(): Promise<SuggestionsResponse> {
  const { data } = await apiClient.get<SuggestionsResponse>(
    "/api/suggestions",
  );
  return data;
}
```

- [ ] **Step 3: 写 format-stats.ts**

`apps/web-agent/src/lib/format-stats.ts`:
```typescript
/** 0–23 小时 → "6 PM"；null → "—"。 */
export function formatPeakHour(hour: number | null): string {
  if (hour === null) return "—";
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${period}`;
}

/** 连续天数 → "3d"。 */
export function formatStreak(days: number): string {
  return `${days}d`;
}
```

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck --filter=@meshbot/web-agent`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/web-agent/public/logo.svg apps/web-agent/src/rest/stats.ts apps/web-agent/src/lib/format-stats.ts
git commit -m "feat(web-agent): logo public 资源 + stats rest + 格式化工具"
```

---

## Task 10: SuggestionChips 组件

**Files:**
- Create: `apps/web-agent/src/components/common/suggestion-chips.tsx`

- [ ] **Step 1: 写组件**

`apps/web-agent/src/components/common/suggestion-chips.tsx`:
```typescript
"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { fetchSuggestions } from "@/rest/stats";

interface SuggestionChipsProps {
  /** 点击胶囊：把文本填入输入框（不自动发送）。 */
  onPick: (text: string) => void;
}

/**
 * 输入框上方的"下一步行动建议"胶囊。
 * - 挂载后自取建议；loading 显示骨架。
 * - 后端返回空（无会话）→ 用 i18n 默认建议兜底。
 * - 请求失败 → 静默隐藏，不阻塞输入。
 */
export function SuggestionChips({ onPick }: SuggestionChipsProps) {
  const t = useTranslations("home");
  // null = loading；[] = 隐藏
  const [items, setItems] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchSuggestions()
      .then((res) => {
        if (!alive) return;
        const list =
          res.suggestions.length > 0
            ? res.suggestions
            : (t.raw("defaultSuggestions") as string[]);
        setItems(list);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [t]);

  if (items === null) {
    return (
      <div className="mb-2 flex flex-wrap gap-2">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-7 w-28 animate-pulse rounded-full bg-accent/30"
          />
        ))}
      </div>
    );
  }
  if (items.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {items.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="rounded-full bg-accent px-3 py-1 text-[13px] text-foreground transition-colors hover:bg-accent/80"
        >
          {s}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck --filter=@meshbot/web-agent`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/components/common/suggestion-chips.tsx
git commit -m "feat(web-agent): SuggestionChips 建议胶囊组件"
```

---

## Task 11: 重写首页 page.tsx（logo + 随机标题 + 真实 stats + range toggle + chips）

**Files:**
- Modify: `apps/web-agent/src/app/page.tsx`

- [ ] **Step 1: 用下面内容整体替换 page.tsx**

`apps/web-agent/src/app/page.tsx`:
```typescript
"use client";

import type { StatsRange, StatsResponse } from "@meshbot/types-agent";
import { Card, CardContent, CardHeader, CardTitle } from "@meshbot/design";
import { useSetAtom } from "jotai";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { addSessionAtom } from "@/atoms/sessions";
import { ActivityHeatmap } from "@/components/common/activity-heatmap";
import {
  ChatInput,
  type ChatInputHandle,
} from "@/components/common/chat-input";
import { SuggestionChips } from "@/components/common/suggestion-chips";
import { AppShellLayout } from "@/components/layouts/app-shell-layout";
import { formatTokens } from "@/lib/format-tokens";
import { formatPeakHour, formatStreak } from "@/lib/format-stats";
import { createSession } from "@/rest/session";
import { fetchStats } from "@/rest/stats";

const RANGES: StatsRange[] = ["all", "30d", "7d"];

export default function Home() {
  const t = useTranslations("home");
  const router = useRouter();
  const addSession = useSetAtom(addSessionAtom);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<ChatInputHandle>(null);

  // 随机标题：首帧用第 0 条，挂载后随机替换，避免 SSR/CSR hydration mismatch
  const titles = (t.raw("titles") as string[]) ?? [t("title")];
  const [titleIdx, setTitleIdx] = useState(0);
  useEffect(() => {
    if (titles.length > 1) {
      setTitleIdx(Math.floor(Math.random() * titles.length));
    }
  }, [titles.length]);
  const title = titles[titleIdx] ?? t("title");

  // 真实 stats + range 筛选
  const [range, setRange] = useState<StatsRange>("all");
  const [stats, setStats] = useState<StatsResponse | null>(null);
  useEffect(() => {
    let alive = true;
    fetchStats(range)
      .then((s) => {
        if (alive) setStats(s);
      })
      .catch(() => {
        if (alive) setStats(null);
      });
    return () => {
      alive = false;
    };
  }, [range]);

  /** 发送消息：创建新会话并跳转到会话页 */
  const handleSend = async (msg: string) => {
    if (sending) return;
    setSending(true);
    try {
      const { sessionId, session } = await createSession(msg);
      addSession(session);
      router.push(`/session?id=${sessionId}`);
    } catch (err) {
      console.error("创建会话失败", err);
      setSending(false);
    }
  };

  const handlePickSuggestion = (text: string) => {
    setDraft(text);
    inputRef.current?.focus(text);
  };

  const metrics = [
    { label: t("metrics.sessions"), value: String(stats?.sessions ?? 0) },
    { label: t("metrics.messages"), value: String(stats?.messages ?? 0) },
    {
      label: t("metrics.totalTokens"),
      value: stats ? formatTokens(stats.totalTokens) : "0",
    },
    { label: t("metrics.activeDays"), value: String(stats?.activeDays ?? 0) },
    {
      label: t("metrics.currentStreak"),
      value: formatStreak(stats?.currentStreak ?? 0),
    },
    {
      label: t("metrics.longestStreak"),
      value: formatStreak(stats?.longestStreak ?? 0),
    },
    {
      label: t("metrics.peakHour"),
      value: formatPeakHour(stats?.peakHour ?? null),
    },
    {
      label: t("metrics.favoriteModel"),
      value: stats?.favoriteModel ?? "—",
    },
  ];

  const heatmapData = (stats?.heatmap ?? []).map((c) => c.count);
  const heatmapMax = Math.max(1, ...heatmapData);

  return (
    <AppShellLayout>
      <div className="w-full max-w-[620px] flex-1">
        <div className="mb-4 flex items-center gap-3">
          <img src="/logo.svg" alt="meshbot" className="h-9 w-9 shrink-0" />
          <h1 className="text-[38px] leading-none font-medium tracking-[-0.015em] text-foreground">
            {title}
          </h1>
        </div>

        <Card className="overflow-hidden border-border bg-muted shadow-none">
          <CardHeader className="space-y-3 pb-2">
            <div className="flex items-center justify-end text-[12px] text-foreground/70">
              <div className="flex items-center gap-3">
                {RANGES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRange(r)}
                    className={
                      r === range
                        ? "rounded-md bg-accent px-2 py-1 font-medium text-foreground"
                        : "px-1 py-1 text-foreground/70 hover:text-foreground"
                    }
                  >
                    {r === "all" ? t("all") : r}
                  </button>
                ))}
              </div>
            </div>
            <CardTitle className="sr-only">{t("overviewMetrics")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-4 gap-1.5">
              {metrics.map((item) => (
                <div
                  key={item.label}
                  className="rounded-[6px] bg-accent px-2.5 py-2 text-foreground"
                >
                  <p className="text-[11px] text-card-foreground">
                    {item.label}
                  </p>
                  <p className="mt-1 text-[30px] leading-[0.95] font-medium tracking-tight">
                    {item.value}
                  </p>
                </div>
              ))}
            </div>

            <ActivityHeatmap data={heatmapData} maxValue={heatmapMax} />
          </CardContent>
        </Card>
      </div>
      <div className="sticky bottom-4 mt-auto bg-background pt-4">
        <SuggestionChips onPick={handlePickSuggestion} />
        <ChatInput
          ref={inputRef}
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          isLoading={sending}
        />
      </div>
    </AppShellLayout>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck --filter=@meshbot/web-agent`
Expected: 通过。

> 若 `formatTokens` 的签名与此处用法不符（它在 `@/lib/format-tokens`，chat-input 已用），按其真实签名调整 `formatTokens(stats.totalTokens)` 调用；它本就是把数字 token 格式化为 `4.2M` 之类。

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/app/page.tsx
git commit -m "feat(web-agent): 首页接 logo + 随机标题 + 真实 stats + 筛选 + 建议胶囊"
```

---

## Task 12: 整体验证

**Files:** 无（验证）

- [ ] **Step 1: 全量类型检查 + 测试**

Run:
```bash
pnpm typecheck
pnpm test -- stats
pnpm test -- suggestion
```
Expected: typecheck 全过；stats / suggestion 相关单测全过。

- [ ] **Step 2: 静态围栏（含 repo 围栏验证新 Service 未越权注入 Repository）**

Run: `pnpm check`
Expected: 6 围栏全过（重点 `check:repo`：StatsService/SuggestionService 只注入 Service，不持有 Repository → 无新增 finding）。

- [ ] **Step 3: i18n 对齐**

Run: `pnpm sync:locales -- --check`
Expected: `Done (missing=0, asymmetric=0)`。

- [ ] **Step 4: 手动跑首页**

启动 `pnpm dev:server-agent` + `pnpm dev:web-agent`，浏览器开 http://localhost:3001 ：
- 标题左侧出现 logo；多次刷新标题在 5 条间随机变化；无 console hydration 警告。
- 指标卡为真实数字（与库一致）；切换 `全部/30d/7d` 后指标与热力图随之变化。
- 输入框上方出现 3 个建议胶囊（有会话时与历史标题相关；空库为默认 3 条）；点击胶囊后文本填入输入框、输入框聚焦、未自动发送。

- [ ] **Step 5: 收尾说明**

确认无遗留 mock（page.tsx 不再有 `heatmapData = Array.from(...)` 与硬编码 `metrics` 值）。本计划完成。
```bash
git log --oneline -12
```

---

## Self-Review

**Spec coverage：**
- Part 1（logo + 随机标题）→ Task 8（titles i18n）+ Task 9（logo public）+ Task 11（page 渲染 logo + 客户端随机）。✓
- Part 2（真实 stats + 筛选生效）→ Task 1（schema）+ Task 2（streak/peakHour）+ Task 3（聚合）+ Task 4（StatsService）+ Task 7（端点）+ Task 11（range toggle + 接线）。✓ 8 指标 + 热力图 + 三档筛选全覆盖。
- Part 3（建议胶囊）→ Task 5（解析）+ Task 6（SuggestionService 缓存 + 标题上下文）+ Task 7（端点）+ Task 8（默认建议 i18n）+ Task 10（组件）+ Task 11（接线，点击填入不自动发送）。✓ 空库默认建议、缓存命中均覆盖。

**Placeholder scan：** 无 TBD/TODO；每段都给了完整代码与命令。✓

**Type consistency：** `StatsResponse` 8 字段在 Task 1 定义，Task 4 构造、Task 11 消费一致；`activitySince` 返回 `{ total, byDate, byHour }` 在 Task 3 定义、Task 4 消费一致；`getSuggestions(): string[]`、`SuggestionsResponse{ suggestions }`、`fetchSuggestions()` 一致；`ChatInputHandle.focus(withText?)` 与 Task 11 `inputRef.current?.focus(text)` 一致；`formatTokens` 复用既有。✓

**已知需实现时校准点（非阻塞）：**
- `GraphService`/`PromptService` 的 import 来源以 `session-title.service.ts` 实际写法为准。
- SQLite `datetime()`/`strftime(...,'localtime')` 行为在 better-sqlite3 下符合预期（Task 3 的单测即验证）。
- 若全局鉴权要求 token，冒烟 curl 需带 `Authorization`。
