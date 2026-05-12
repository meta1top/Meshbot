# 概览区域细节优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化首页概览面板的布局、颜色和对齐方式，提取 ActivityHeatmap 组件。

**Architecture:** 提取 ActivityHeatmap 组件处理日历颜色映射，page.tsx 调整布局结构，修复指标 label 颜色确保明暗主题可读。

**Tech Stack:** Next.js 15, React 19, Tailwind CSS v4, shadcn/ui, next-intl

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `apps/web-agent/src/components/common/activity-heatmap.tsx` | 创建 | 活跃日历组件，处理颜色映射 |
| `apps/web-agent/src/app/page.tsx` | 修改 | 概览面板布局调整 |
| `apps/web-agent/messages/zh.json` | 修改 | 移除 `home.tokenComparison` |
| `apps/web-agent/messages/en.json` | 修改 | 移除 `home.tokenComparison` |

---

### Task 1: 创建 ActivityHeatmap 组件

**Files:**
- Create: `apps/web-agent/src/components/common/activity-heatmap.tsx`

- [ ] **Step 1: 编写 ActivityHeatmap 组件**

```tsx
"use client";

import { cn } from "@meshbot/design";

interface ActivityHeatmapProps {
  data: number[];
  maxValue: number;
  className?: string;
}

function getIntensityClass(value: number, maxValue: number): string {
  if (value <= 0) return "bg-background";
  const ratio = value / maxValue;
  if (ratio <= 0.3) return "bg-accent/20";
  if (ratio <= 0.7) return "bg-accent/50";
  return "bg-accent";
}

export function ActivityHeatmap({
  data,
  maxValue,
  className,
}: ActivityHeatmapProps) {
  return (
    <div className={cn("grid grid-cols-16 gap-1", className)}>
      {data.map((value, index) => (
        <span
          key={index}
          className={cn("h-5 rounded-[3px]", getIntensityClass(value, maxValue))}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: 运行 biome 格式化**

```bash
npx biome check --write apps/web-agent/src/components/common/activity-heatmap.tsx
```

- [ ] **Step 3: Commit**

```bash
git add apps/web-agent/src/components/common/activity-heatmap.tsx
git commit -m "feat(web-agent): add ActivityHeatmap component

- 96 格日历布局，grid-cols-16
- 根据 token 用量使用 bg-accent 不同透明度
- 无数据时 bg-background"
```

---

### Task 2: 修改 page.tsx 概览面板

**Files:**
- Modify: `apps/web-agent/src/app/page.tsx`

- [ ] **Step 1: 修改导入**

添加 ActivityHeatmap 导入，移除不需要的：
```tsx
import { ActivityHeatmap } from "@/components/common/activity-heatmap";
```

- [ ] **Step 2: 修改外层容器为左对齐**

将第 25 行：
```tsx
<div className="mx-auto w-full max-w-[620px] flex-1">
```
改为：
```tsx
<div className="w-full max-w-[620px] flex-1">
```

- [ ] **Step 3: 修改 CardHeader 移除左侧切换**

将第 34~49 行的 CardHeader 内容替换为：
```tsx
<CardHeader className="space-y-3 pb-2">
  <div className="flex items-center justify-end text-[12px] text-foreground/70">
    <div className="flex items-center gap-3">
      <span className="rounded-md bg-accent px-2 py-1 font-medium text-foreground">
        {t("all")}
      </span>
      <span>30d</span>
      <span>7d</span>
    </div>
  </div>
  <CardTitle className="sr-only">{t("overviewMetrics")}</CardTitle>
</CardHeader>
```

- [ ] **Step 4: 修复指标 label 颜色**

将第 59 行：
```tsx
<p className="text-[11px] text-muted-foreground">
```
改为：
```tsx
<p className="text-[11px] text-card-foreground">
```

- [ ] **Step 5: 替换热力图为 ActivityHeatmap 组件**

将第 69~79 行：
```tsx
<div className="grid grid-cols-16 gap-1">
  {heatmapCells.map((cell) => (
    <span
      key={cell}
      className="h-5 rounded-[3px] bg-accent"
      style={
        cell === 79 ? { backgroundColor: "#3b82f6" } : undefined
      }
    />
  ))}
</div>
```
改为：
```tsx
<ActivityHeatmap
  data={heatmapCells.map((cell) => (cell === 79 ? 100 : cell % 5 === 0 ? 50 : 0))}
  maxValue={100}
/>
```

同时移除顶部的 `const heatmapCells = Array.from({ length: 96 }, (_, index) => index);`

改为：
```tsx
const heatmapData = Array.from({ length: 96 }, (_, index) =>
  index === 79 ? 100 : index % 5 === 0 ? 50 : 0
);
```

- [ ] **Step 6: 移除 Token 对比文案**

删除第 81~84 行：
```tsx
<div className="flex items-center justify-between text-[11px] text-muted-foreground">
  <span>{t("tokenComparison")}</span>
  <div className="h-8 w-2 rounded bg-accent" />
</div>
```

- [ ] **Step 7: 运行 biome 格式化**

```bash
npx biome check --write apps/web-agent/src/app/page.tsx
```

- [ ] **Step 8: Commit**

```bash
git add apps/web-agent/src/app/page.tsx
git commit -m "refactor(web-agent): refine overview panel layout

- 左对齐（移除 mx-auto）
- 移除左侧概览/模型切换
- 修复指标 label 颜色为 text-card-foreground
- 使用 ActivityHeatmap 组件替换原生热力图
- 移除 Token 对比文案"
```

---

### Task 3: 清理国际化文案

**Files:**
- Modify: `apps/web-agent/messages/zh.json`
- Modify: `apps/web-agent/messages/en.json`

- [ ] **Step 1: 从 zh.json 移除废弃 key**

删除 `home.tokenComparison` 行。

- [ ] **Step 2: 从 en.json 移除废弃 key**

删除 `home.tokenComparison` 行。

- [ ] **Step 3: 运行 biome 格式化**

```bash
npx biome check --write apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
```

- [ ] **Step 4: Commit**

```bash
git add apps/web-agent/messages/zh.json apps/web-agent/messages/en.json
git commit -m "i18n(web-agent): remove home.tokenComparison key"
```

---

## Self-Review

### 1. Spec Coverage

| Spec 要求 | 对应 Task |
|-----------|-----------|
| 左对齐 | Task 2 Step 2 |
| 移除左侧概览/模型切换 | Task 2 Step 3 |
| 移除 Token 对比文案 | Task 2 Step 6 |
| 修复指标 label 颜色 | Task 2 Step 4 |
| 活跃日历组件 | Task 1 |
| 使用 ActivityHeatmap | Task 2 Step 5 |
| 清理 i18n | Task 3 |

无遗漏。

### 2. Placeholder Scan

无 TBD、TODO、"implement later" 等占位符。

### 3. Type Consistency

- `ActivityHeatmapProps` 中的 `data` 为 `number[]`，与使用时的 `heatmapData` 类型一致
- `maxValue` 为 `number`，用于计算透明度比例

---

## 验证清单

- [ ] 概览面板内容左对齐
- [ ] 顶部只显示时间范围选择（右对齐）
- [ ] 指标 label 在明暗主题下都清晰可读
- [ ] 活跃日历默认背景为 bg-background
- [ ] 有数据的格子显示不同深度的 bg-accent
- [ ] Token 对比文案已移除
- [ ] 切换中英文后无 missing key
- [ ] `pnpm check` 或 `npx biome check` 通过
