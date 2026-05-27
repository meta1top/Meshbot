# 新会话页（首页）优化 — 设计稿

> 日期：2026-05-27
> 范围：`apps/web-agent` 首页（`src/app/page.tsx`，标题"接下来做什么？" + stats + 输入框）+ `apps/server-agent` 两个新端点。
> 三部分相互独立，可分别实施。

## 现状

- 首页 [apps/web-agent/src/app/page.tsx](../../apps/web-agent/src/app/page.tsx)：标题走 i18n `t("home.title")`；8 个指标卡 + 热力图数据**全是 mock 硬编码**（page.tsx 内 `metrics` 数组与 heatmap 数组）；输入框 `ChatInput` 用组件默认 placeholder。
- 后端已有：`SessionService.listAllSorted()`（列会话，带 title）、`LlmCallService.getSessionTotals()`（按会话聚合 token）、`SessionTitleService.generate()`（一次性 `getTitleModel().invoke()` 生成标题的可复用模式）。**无 stats 端点、无 suggestions 端点**。
- 实体字段齐全：`LlmCall{ model, totalTokens, createdAt, sessionId }`、`SessionMessage{ role, createdAt, sessionId }`、`Session{ title, updatedAt, ... }`。
- i18n：next-intl，locale 文件 `apps/web-agent/messages/{zh,en}.json`，命名空间 per feature。

## Part 1 — Logo + 随机标题（纯前端）

- 标题前插入 `apps/web-agent/src/assets/image/logo.svg`，与 `<h1>` 同行（logo 在左，垂直居中）。
- i18n：把单条 `home.title` 改为数组 `home.titles`（zh/en 各 5 条，简洁中性调性，偏生产力不卖萌）。组件用 `t.raw("home.titles")` 取数组。
  - zh 提议：`接下来做什么？` / `今天想推进点什么？` / `从哪里开始？` / `有什么我能帮上忙的？` / `准备好了吗？`
  - en 提议：`What's up next?` / `What are we working on?` / `Where shall we start?` / `What can I help with?` / `Ready when you are.`
- 随机选取在**客户端挂载后**进行：`useEffect` 里 `setIdx(Math.floor(Math.random() * titles.length))`；首帧渲染第 0 条，挂载后替换，避免 SSR/CSR hydration mismatch。

**验收**：首页标题左侧有 logo；多次刷新标题在 5 条间随机；无 hydration 警告。

## Part 2 — 真实 stats（后端端点 + 前端接线）

### 端点
`GET /api/stats?range=all|30d|7d`（默认 `all`）。响应 envelope data：
```ts
{
  sessions: number;        // 范围内会话数
  messages: number;        // 范围内消息数
  totalTokens: number;     // 范围内 SUM(total_tokens)
  activeDays: number;      // 范围内有活动的去重天数
  currentStreak: number;   // 截至今天的连续活跃天数
  longestStreak: number;   // 范围内最长连续活跃天数
  peakHour: number | null; // 0–23，消息最多的小时；无数据为 null
  favoriteModel: string | null; // 范围内出现次数最多的 model；无为 null
  heatmap: { date: string; count: number }[]; // 按天消息计数（date = YYYY-MM-DD 本地时区）
}
```

### 后端结构（遵守 check:repo：不跨实体注入 Repository）
新 `StatsService` 注入三个归属 Service，**组合**它们暴露的聚合方法：
- `SessionService`：`countInRange(since: Date | null): Promise<number>`
- `SessionMessageService`（新增聚合方法，均以归属 Repository 上的 QueryBuilder 实现）：
  - 范围内消息总数
  - 按本地日期分组的计数（→ activeDays / heatmap / streak 的来源天集合）
  - 按本地小时（0–23）分组的计数（→ peakHour）
- `LlmCallService`：`sumTokensInRange(since)`、`modelFrequencyInRange(since)`（→ favoriteModel）
- `StatsService` 用纯函数从「活跃天集合」算 `currentStreak` / `longestStreak`（独立可单测）。

range → since：`7d` = now-7d，`30d` = now-30d，`all` = null（无下界）。所有时间过滤按记录 `created_at`。时区按服务器本地时区做"天/小时"分桶（本地轨单机单用户，可接受）。

SQLite 本地单用户，聚合查询直接算、**不缓存**。

### 前端
- 新 `useStats(range)` hook（`apps/web-agent/src/rest/stats.ts` + atom 或直接 hook）。
- `page.tsx` 删除 mock `metrics` / heatmap 数组，改用 hook 数据；指标值格式化（token → `4.2M`、peakHour 数字 → `6 PM`、streak → `Nd`）放前端格式化工具。
- 右上角 `全部/30d/7d` toggle 成为受控状态，切换即换 range 重新拉取。
- loading / 空数据态：指标显示骨架或 `0`/`—`，热力图空网格。

**验收**：三档筛选切换后 8 指标与热力图随真实数据变化；新建会话/发消息后刷新数值递增；空库显示 0/—。

## Part 3 — 下一步行动建议胶囊（后端端点 + 前端组件）

### 端点
`GET /api/suggestions`。响应 envelope data：`{ suggestions: string[] }`（3 条短建议）。
- 取最近 20 条会话标题（`SessionService.listAllSorted()` 取前 20 的 `title`）为上下文。
- 复用一次性 LLM 调用模式：`GraphService.getTitleModel().invoke(prompt)`；新增 prompt 模板键 `next-action-suggestions`（`PromptService`），要求模型输出 3 条简短、可直接作为下一步任务的中文/当前语言建议。
- 输出解析：按行/分隔切分 → 取前 3 条 → 清洗（去序号/引号）。

### 缓存（新 `SuggestionService`，内存缓存）
- key = 前 20 条标题拼接后的 hash。标题集合变化（新建会话 / 标题生成完成）→ hash 变 → cache miss → 重新调用 LLM。
- TTL 兜底 30 分钟。
- 空 titles（无会话）：**不调 LLM**，返回一组静态默认建议（i18n `home.defaultSuggestions`）。

### 前端
- 新 `SuggestionChips` 组件，放 `ChatInput` **上方**。
- loading 骨架态（chip 占位）。
- 点击 chip → **填入输入框**（不自动发送，用户可继续编辑）。
- 拉取失败：静默隐藏胶囊区（不阻塞输入）。

**验收**：有会话时胶囊显示 3 条与历史标题相关的建议；点击填入输入框；标题不变时二次进入命中缓存（不重复调 LLM）；空库显示静态默认建议。

## 已定默认（可在 review 阶段推翻）
- 建议 **3 条**；点击 **填入不自动发送**；stats **不缓存**；随机标题 **5 条/语言**；suggestions 缓存 **30 分钟 TTL**。

## 不在本次范围
- stats 的跨设备/云端聚合（本地轨单机）。
- 建议的多轮/可刷新"换一批"按钮（YAGNI；缓存已覆盖新鲜度）。
- 输入框 placeholder 的 i18n 化（与本需求无关，不动）。
