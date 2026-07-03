# dispatch_subagent「Agent 任务卡」UI 重设计 spec

## 1. 背景与目标

1b/Phase 2 的嵌套卡复用了普通工具块的视觉语言，用户验收反馈：subagent 是特殊场景，应有专属、更友好的 UI。方向已确认（设计稿：https://claude.ai/code/artifact/30b6076c-ea74-46fd-8e6c-872428df2b86 ，v1-任务卡六状态）：**把卡做成迷你任务面板**——子 Agent 是「一个在跑的任务」，不是「一次工具调用」。

**纯前端改造**（web-agent），后端零改动；全部既有认领/折叠/停止/settled 逻辑复用（`subagent-card.ts` 纯函数微扩，不动语义）。视觉沿用 web-agent 现有语言（系统字 / 13px 层级 / 8px 圆角 / 品牌橙 / lucide）。

## 2. 卡片结构（按设计稿）

### 2.1 头部（所有状态恒在）

`[专属图标] [任务标题] [「后台」签?] [状态胶囊] [meta] [spacer] [停止按钮?] [chevron]`

- **专属图标**：嵌套方块 SVG（外框+内实心块），22×22 圆角 6px 色块底——运行/启动=品牌橙，done=绿、error=红、aborted=灰（低饱和语义色，主信号仍是胶囊）。内联 SVG，不引外部资源。
- **标题**：`subagentTitle`（既有），semibold 13px，truncate。
- **「后台」签**：描边小胶囊，仅 `background:true`（从工具 args 或结果 JSON 判定）显示。
- **状态胶囊**：运行中（橙底橙字+呼吸点）/ ✓ 已完成（绿）/ ✗ 失败（红）/ ⏹ 已中止（灰）/ 启动中（灰+呼吸点）。文案复用既有 `session.subagent` i18n 键。
- **meta**：`N 工具 · M:SS`（11px、tabular-nums）。工具计数=子流 assistant 消息的 toolCalls 总数；耗时**前端本地计时**——从卡首次认领（拿到 subSessionId）起算，终态冻结；刷新后历史卡不显示耗时（无起点数据，留空即可）。
- **停止按钮**：仅运行中显示（既有条件 `active && subSessionId`），独立命中区（与折叠切换分离，沿 Phase 2 的 sibling 结构）。
- 运行中时卡片整体升温：描边转暖色 + 头部微渐变（设计稿 `.card.running`）。

### 2.2 当前动作行（折叠态核心增量）

折叠且运行中时，头部下方一条 12px 虚线分隔的单行：`[spinner] 正在执行 <工具中文名>（<args 摘要>）`。

- 派生规则（纯函数 `deriveLiveAction(messages)`）：取子流**最后一个** status ∈ running|streaming 的工具调用 → 工具名走 `toolDisplayName` + args 摘要（复用/提炼 tool-call-block 的 `formatArgsSummary` 逻辑）；无进行中工具时取子流最后一条 assistant 正文的**末行截断**（前缀不加「正在执行」，直接显示文本）；两者皆无 → 不渲染该行。
- 展开时隐藏（嵌套流本身可见，无需重复）。

### 2.3 结果行（终态折叠）

终态且折叠时，同位置显示 `→ <结果一句话>`：output 首行截断（~80 字符）；error/aborted 用既有文案（`子 Agent 运行失败…`/`已手动停止；已完成部分保留在子会话中`——后者为新 i18n 键）。箭头色随语义。数据来自工具结果 JSON（终态已由 settled/重写保证）。

### 2.4 展开态

嵌套流完全复用现状（`MessageList nested`、限高内滚、吸底）；底色 `--stream-bg` 微调与主流区分（现已近似，保持）。新增**footer** 一行（11px、faint）：运行中 `子会话 · N 条消息 · 输出实时滴流中`；终态 `子会话 · N 条消息 · 用时 M:SS`（无计时起点则省耗时段）。

### 2.5 启动中占位

未认领（subSessionId=null）：图标半透明、标题灰显 fallback、胶囊「启动中」+呼吸点，无动作行/不可展开/无停止（现状语义不变，仅套新皮）。

## 3. 实现约束

- 新纯函数入 `apps/web-agent/src/lib/subagent-card.ts`（零 import 纪律）：`deriveLiveAction`、`firstLineOf`（结果行截取）、`countToolCalls`；耗时格式化 `formatElapsed(ms)`。全部可被根 jest 测。
- `SubagentCard` 组件重写（结构变化大，允许整文件重写），但对外 props 与接入点（tool-call-block 特判）不变。
- args 摘要若从 tool-call-block 提炼公共函数，注意该文件的既有导出不破坏；或在纯模块内独立实现简化版（对象浅层 k:v 拼接截断）——**取后者**（避免动 tool-call-block，YAGNI）。
- i18n：`session.subagent` 补 `toolsCount`（"{count} 工具"）、`elapsed`、`streamFooterRunning`、`streamFooterDone`、`abortedResult` 等缺失键（`starting`/状态文案/`stop` 为既有键复用），zh/en 对称。
- 动效尊重 `prefers-reduced-motion`（呼吸点/spinner）。
- 不做（明确出界）：在完整页打开子会话、用量展示、播报消息特殊渲染、暗色主题单独调优（跟随既有 token 自然适配）。

## 4. 测试与验收

- 纯函数单测（根 jest）：deriveLiveAction 三分支（running 工具/正文末行/空）、firstLineOf 截断、countToolCalls、formatElapsed。
- typecheck/biome/sync-locales；组件行为靠人工验收：六状态对照设计稿逐一核对（运行折叠含动作行、展开、done/error/aborted 结果行、启动中、后台签、停止、计时冻结）。
- 全量根 jest 收尾（惯例）。
