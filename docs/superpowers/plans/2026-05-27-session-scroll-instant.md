# 会话页滚动 smooth → instant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把会话页两处 `scrollIntoView({ behavior: "smooth" })` 改为 `{ behavior: "instant", block: "end" }`，消除首屏滚动闪烁、流式中手势冲突、回到底部按钮动画跟不上 chunk 三个体验问题。

**Architecture:** 单文件 2 行改动（`apps/web-agent/src/app/session/page.tsx`）。无新增 state、无 throttle / 监听、无测试增量。

**Tech Stack:** React + Next.js（既有），原生 `Element.scrollIntoView`。

---

## 文件结构

**Spec ref：** `docs/superpowers/specs/2026-05-27-session-scroll-instant-design.md`

| 路径 | 责任 |
|---|---|
| `apps/web-agent/src/app/session/page.tsx`（改） | 流式 / 新消息跟随 effect、「回到底部」按钮 onClick；其它逻辑不动 |

---

## Task 1：两处 scrollIntoView 改 instant + block:end

**Files:**
- Modify: `apps/web-agent/src/app/session/page.tsx:566`
- Modify: `apps/web-agent/src/app/session/page.tsx:817`

- [ ] **Step 1：改流式 / 新消息跟随 effect（line 566）**

把：

```ts
  useEffect(() => {
    if (!stickToBottom) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timelineMessages, stickToBottom]);
```

改为：

```ts
  useEffect(() => {
    if (!stickToBottom) return;
    // instant：流式 chunk 持续到达时多次重触发也不会动画堆叠；
    // 与用户手势同帧争抢 scrollTop 的卡顿一并消除。
    bottomRef.current?.scrollIntoView({
      behavior: "instant",
      block: "end",
    });
  }, [timelineMessages, stickToBottom]);
```

- [ ] **Step 2：改「回到底部」按钮 onClick（line 817）**

把：

```tsx
            onClick={() => {
              setStickToBottom(true);
              bottomRef.current?.scrollIntoView({ behavior: "smooth" });
            }}
```

改为：

```tsx
            onClick={() => {
              setStickToBottom(true);
              // instant：流式期间点击时立刻贴底；后续 chunk 走同款 instant 跟随，
              // 不再有「动画跟不上 chunk」的累积。
              bottomRef.current?.scrollIntoView({
                behavior: "instant",
                block: "end",
              });
            }}
```

- [ ] **Step 3：typecheck**

```bash
pnpm --filter @meshbot/web-agent typecheck
```

Expected：exit 0（`ScrollBehavior` 类型已含 `"instant"`）。

- [ ] **Step 4：手测 — 三个 spec 验证场景**

启动 server-agent + web-agent 各自 dev：

```bash
pnpm dev:server-agent
pnpm dev:web-agent
```

逐一验证：

1. **首次加载有历史的会话**：点侧边栏一个有 ≥ 一屏消息的会话 → 视口直接到底部，无「先看顶部 → 滑下来」的动画。
2. **流式中往上滚**：发一条会让 assistant 较长输出的消息（如「写一首长诗」） → 流式期间用滚轮 / 触控板向上滚 → 视口立刻停留在用户位置，不被「拽回」；持续 chunk 也不再跟随。
3. **流式中点回到底部**：续上一步，离开底部后右下角出现「回到底部」按钮 → 点击 → 视口瞬间到底，后续 chunk 持续贴底（无动画错位）。
4. **空会话发新消息**：在新会话输入框发一条 → 用户消息 + loading 出现在底部，视口立刻贴底。

- [ ] **Step 5：commit**

```bash
git add apps/web-agent/src/app/session/page.tsx
git commit -m "$(cat <<'EOF'
fix(web-session): 滚动 smooth → instant，消除首屏闪、手势冲突、动画堆叠

两处 scrollIntoView 从 behavior:"smooth" 改 instant + block:"end"：
- 流式/新消息跟随 effect：避免 chunk 持续到达时动画与手势同帧争抢
- 回到底部按钮：避免点击后动画与后续 chunk 持续 smooth 触发的错位

instant 同步完成，无动画状态；IO 哨兵基于「在不在视口」翻转 stickToBottom，
instant 下行为更确定，不需要节流 / 手势监听。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage：**
- 问题 ①（首屏闪） → Step 1 effect 改 instant ✓
- 问题 ②（流式中手势卡顿） → Step 1 effect 改 instant（同一处）✓
- 问题 ③（回到底部跟不上 chunk） → Step 2 按钮改 instant ✓
- 不动的部分（IO 哨兵 / 顶部翻页 / 按钮显示条件 / state）— plan 未触碰，符合 spec「不动的部分」与「不在范围」清单 ✓

**Placeholder scan：** 无 TBD / 「类似 Task N」 / 「适当处理边缘场景」等占位 ✓

**Type consistency：** 仅改 `ScrollIntoViewOptions` 参数对象内的 `behavior` 值 + 新增 `block`，类型由 TS lib 提供，前后一致 ✓

**已知整合点：** Step 1 / Step 2 的行号 566 / 817 基于 spec 落地时的文件状态；若执行时行号略有漂移，按 effect 体里的 `bottomRef.current?.scrollIntoView` 与按钮 onClick 内的 `scrollIntoView` 这两处文本特征定位即可。
