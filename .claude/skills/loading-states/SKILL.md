---
name: loading-states
description: 写前端加载态（页面首载/按钮请求/数据刷新）时的规范——何时骨架屏、何时内联 spinner、何时静默刷新
---

# 加载态规范

## 三条规则

1. **整页 / 大区块首载 → 骨架屏**。用 `@meshbot/design` 的 `Skeleton`，
   形状贴近真实内容（标题行/头像/按钮各归其位），禁止整页大 spinner。
   参考示范：`apps/web-main/src/app/authorize/page.tsx` 首载分支。
2. **按钮 / 小操作请求 → 按钮内联 spinner + disabled**。文案左侧
   `<Loader2 className="h-3.5 w-3.5 animate-spin" />`，不弹遮罩、不换按钮尺寸。
3. **已有数据的刷新 → 静默后台更新**。React Query 的 refetch 不显示加载态，
   不闪骨架（`isPending` 才骨架，`isFetching` 不骨架）。

## 反模式

- 全屏 spinner 盖住已渲染内容
- 骨架形状与真实内容布局无关（一根孤零零的长条）
- mutation pending 时把按钮换成独立 spinner 元素（布局跳动）
