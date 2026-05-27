# 会话页滚动行为：smooth → instant 设计稿

> 日期：2026-05-27
> 范围：web-agent 会话视图 `apps/web-agent/src/app/session/page.tsx` 的滚动跟随与「回到底部」按钮。

## 现状

`session/page.tsx` 现状两处用 `behavior: "smooth"` 触发底部跟随：

1. **流式 / 新消息跟随 effect**（line 564-567）：依赖 `[timelineMessages, stickToBottom]`，当 `stickToBottom=true` 时每次 timeline 变化都调 `bottomRef.current?.scrollIntoView({ behavior: "smooth" })`。
2. **「回到底部」按钮**（line 815-818）：`onClick` 里调同款 `scrollIntoView({ behavior: "smooth" })` 并恢复 `stickToBottom=true`。

底部哨兵 IO（line 574-587）通过 `bottomRef` 在视口内 / 不在视口内来翻转 `stickToBottom`，不读 scroll 事件 + 阈值。

## 问题

| # | 现象 | 根因 |
|---|---|---|
| ① | 首次加载会话时，先看到顶部、再被动画滑到底部，闪一下 | smooth 动画从初始 scrollTop=0 滑到底部，肉眼可见 |
| ② | 流式输出中，用户主动往上滚不顺畅、有被卡感 | 每个 chunk 让 effect 重触发 smooth 滚动，与用户滚动手势在同一帧内争抢 scrollTop |
| ③ | 流式输出中点「回到底部」按钮，动画跟不上 chunk | 上一帧 smooth 动画还没完成，新 chunk 又触发新一帧 smooth 动画；动画堆叠 |

三者根因相同：**effect 触发的 smooth 滚动在持续 chunk 下不断重发，且与用户手势竞争**。

## 改动

`apps/web-agent/src/app/session/page.tsx` 两处 `behavior: "smooth"` 改为 `behavior: "instant"`，并显式加 `block: "end"`：

```ts
// line 566（effect 跟随）
bottomRef.current?.scrollIntoView({ behavior: "instant", block: "end" });

// line 817（回到底部按钮）
bottomRef.current?.scrollIntoView({ behavior: "instant", block: "end" });
```

`block: "end"`：明确底部对齐，避免浏览器默认 `start` 行为差异。

**总改动 = 2 行。** 无新增 state、无 throttle / debounce、无 wheel / touch 监听。

## 为什么 instant 同时解决 3 个问题

- **①** instant 跳转无动画，首屏立刻在底部，无「先顶后滑」闪烁。
- **②** 用户滚轮 → IO 哨兵立刻报「离开底部」→ `stickToBottom=false` → effect early-return。**没有正在跑的 smooth 动画与手势竞争**，手感顺滑。
- **③** 单次 instant 跳到底是同步完成的；后续每个 chunk 也是同步 instant 跳到底，视觉上「持续贴底」，不存在「动画跟不上」的累积。

## 不动的部分

- 底部哨兵 IO（line 574-587）：基于「哨兵在不在视口」翻转 `stickToBottom`，instant 跳转下行为更确定，不需要改。
- 顶部「加载更多」的 scrollTop 锚定补偿（line 700-730）：与底部跟随无关。
- 「回到底部」按钮的显示条件（`!stickToBottom`）与悬浮位置：不动。
- `stickToBottom` state 与初始 true：不动。

## 验证

| 场景 | 期望 |
|---|---|
| 首次进入有历史的会话 | 视口直接在底部，无滑动动画 |
| 流式输出中往上滚滚轮 / 触控板 | 视口立刻停在用户停留位置，不被拽回；后续 chunk 不再跟随（直到用户点回到底部） |
| 流式输出中点「回到底部」 | 视口瞬间到底，后续 chunk 持续贴底（无动画错位） |
| 空会话发新消息 | 用户消息 + loading 出现在底部，视口立刻贴底 |

## 不在范围

- 节流 / debounce 滚动调用 — YAGNI，instant 已经消除动画堆叠。
- 「用户接近底部就自动 stick」的智能判定 — 现有 IO 哨兵已足够。
- 顶部翻页 / 锚定逻辑改动。
- smooth 滚动重新引入（如「发送时温柔滚动」）— 与 instant 风格不一致，YAGNI。
