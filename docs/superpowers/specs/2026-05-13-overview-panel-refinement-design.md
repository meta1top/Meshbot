# 概览区域细节优化设计文档

## 背景

当前首页概览面板存在以下问题：
1. 内容居中，应左对齐
2. 顶部有"概览/模型"切换，不需要
3. Token 对比文案和图例需要移除
4. 指标 label 在深色主题下颜色不清晰
5. 活跃日历区域默认背景色与卡片背景融合，需要区分

## 目标

优化概览面板的视觉表现，提升明暗主题下的可读性。

## 设计详情

### 1. 组件结构

```
apps/web-agent/src/
├── components/
│   └── common/
│       └── activity-heatmap.tsx      # 新增：活跃日历组件
├── app/
│   └── page.tsx                      # 修改：概览面板布局调整
└── messages/
    ├── zh.json                       # 修改：清理废弃 key
    └── en.json                       # 修改：清理废弃 key
```

### 2. 布局调整（page.tsx）

**左对齐**：
- 移除 `mx-auto`，改为 `w-full`
- 保留 `max-w-[620px]` 作为最大宽度限制

**顶部导航栏**：
- 删除左侧 "概览" 和 "模型" 标签
- 只保留右侧时间范围选择（`全部`、`30d`、`7d`）
- 时间范围选择右对齐

**指标卡片区域**：
- 4 列网格布局保持不变
- 每个卡片：`rounded-[6px] bg-accent px-2.5 py-2`
- label 颜色：`text-card-foreground`（确保明暗主题清晰）
- 数值颜色：`text-foreground`

**活跃日历区域**：
- 提取为 `ActivityHeatmap` 组件
- 96 个格子，`grid-cols-16`
- 默认背景：`bg-background`
- 有数据时根据 token 量使用 `bg-accent` 不同透明度

**底部**：
- 移除 Token 对比文案和图例

### 3. ActivityHeatmap 组件

**位置**：`apps/web-agent/src/components/common/activity-heatmap.tsx`

**Props**：
```tsx
interface ActivityHeatmapProps {
  data: number[];      // 每个格子的 token 用量，0 表示无数据
  maxValue: number;    // 用于计算透明度
  className?: string;
}
```

**颜色映射**：
- `value === 0` → `bg-background`
- `value > 0 && value <= maxValue * 0.3` → `bg-accent/20`
- `value > maxValue * 0.3 && value <= maxValue * 0.7` → `bg-accent/50`
- `value > maxValue * 0.7` → `bg-accent`

**样式**：
- 格子大小：`h-5`
- 圆角：`rounded-[3px]`
- 间距：`gap-1`

### 4. 颜色修复

**指标 label**：
- 当前：`text-muted-foreground`
- 改为：`text-card-foreground`

**原因**：`text-muted-foreground` 在深色模式下（`oklch(0.708 0 0)`）对比度不足，使用 `text-card-foreground` 可以跟随主题变化，确保可读性。

### 5. 国际化清理

从 `zh.json` 和 `en.json` 移除：
- `home.tokenComparison`

保留：
- `home.overviewMetrics`（用于 `sr-only` 无障碍访问）

## 实现范围

### 本次实现
- [ ] 创建 `ActivityHeatmap` 组件
- [ ] 修改 `page.tsx` 布局（左对齐、移除顶部切换、移除底部文案）
- [ ] 修复指标 label 颜色
- [ ] 清理 i18n 废弃 key

### 后续迭代
- [ ] 接入真实的 token 使用数据
- [ ] ActivityHeatmap 支持 tooltip 显示具体数值

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/web-agent/src/components/common/activity-heatmap.tsx` | 新增 | 活跃日历组件 |
| `apps/web-agent/src/app/page.tsx` | 修改 | 概览面板布局调整 |
| `apps/web-agent/messages/zh.json` | 修改 | 移除 `home.tokenComparison` |
| `apps/web-agent/messages/en.json` | 修改 | 移除 `home.tokenComparison` |
