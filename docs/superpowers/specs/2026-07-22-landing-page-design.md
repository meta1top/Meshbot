# MeshBot 官网落地页设计

日期：2026-07-22
范围：`apps/web-main` 的 `/` 路由改造为公开落地页

## 一、目标与定位

| 维度 | 决定 |
|------|------|
| 页面唯一任务 | 让访客**下载桌面端**并在本地跑起来 |
| 目标受众 | 开发者 / AI 尝鲜者（会配 MCP、接自己的模型、看重开源与本地执行） |
| hero 论点（thesis） | **本地跑，但能远程指挥** |
| 上线时点 | 与**首个 GitHub Release 同步**（Release 未出则 CTA 降级，见 §6） |

**为什么是这个受众**：项目当前 0 star、0 release、桌面端 v0.0.2。此阶段会下载一个本地优先 Agent 的只可能是技术尝鲜者。知识工作者还找不到入口，企业客户所需的信任背书尚不具备。

**为什么是这个 thesis**：它精确落在 Claude Desktop（纯本地、无法远程）与云端 Agent（可远程、但数据上云）**都做不到**的交集上，是当前唯一的结构性差异点。

## 二、页面结构（精简宣言页，约 3 屏）

```
01  HERO          跨设备时序动效 + 主标题 + 下载 CTA
02  你的数据在哪   本机 / 云端 双栏对照表
03  开源 + 下载    技术栈、LICENSE、GitHub、Footer
```

**刻意不做的**（YAGNI）：产品截图墙、「三步上手」、完整架构图。

理由：产品 UI 仍在快速迭代（UI 重构 P3/P4/P5 未做），现在打磨的截图三个月内必然作废；精简结构把全部预算压在 hero 动效——唯一的差异点——上。结构可后加，已上线内容难砍。

## 三、视觉方向

**暖炭 + 排版冒险**。沿用产品既有色板，但排版取一个可辩护的风险。

复用的既有 token（**唯一真相在 `packages/design/src/styles/globals.css`，本页不新增全局色**）：

| 用途 | 值 |
|------|-----|
| 品牌焦橙（全局唯一强调色） | `--brand: #d24a0d` |
| 页面底 | `oklch(0.135 0.008 55)`（= `--shell-chrome`） |
| 面板底（外层） | `oklch(0.17 0.008 55)`（= `--surface-0`） |
| 面板底（工具行 / 卡片） | `oklch(0.205 0.011 55)`（= `--card`） |
| 边框 | `oklch(0.275 0.01 55)`（= `--border`） |
| 主文字 / 次文字 | `oklch(0.96 0.005 55)` / `oklch(0.62–0.71 0.012 55)` |

排版特征（landing 局部，**不上升到 `packages/design`**）：

- 主标题超大紧排：`font-weight: 780`，`letter-spacing: -0.045em`
- 等宽小标签：`ui-monospace / SF Mono / Menlo`，`letter-spacing: .16em`，大写，橙色
- 直角按钮（`border-radius: 2px`），与产品内圆角柔和风格刻意区分
- 橙色仅作手术刀式点缀：强调词、脉冲、边框高亮、产物卡

**割裂感的处理**：落地页是宣言，产品内是工作台，两者气质不同是有意为之，不视为不一致。

**固定暗色**，不跟随系统主题、不提供切换。理由：开发者落地页固定暗色是常规做法；hero 的橙色辉光在亮底上立不住。

## 四、Hero 动效时序（**权威定义**）

> 交互原型在 `.superpowers/brainstorm/*/content/hero-motion.html`，该目录 **gitignored**，故完整参数以本节为准。

三栏布局：**远端（左） | 链路（中） | 本机（右）**，宽度比 `1fr : 92px : 1.45fr`。

一轮 **9 秒**播完，停留 **2 秒**后重启（即每 11 秒起一轮）：

| 时间 | 事件 |
|------|------|
| 1.3s | 远端消息气泡出现：「把 ~/meetings 这周的记录整理成周报」 |
| 1.9s | 橙色脉冲左→右穿过链路（时长 1.5s，`cubic-bezier(.4,0,.5,1)`） |
| 2.7s | 本机面板边框亮起（`rgba(210,74,13,.55)`，0.6s ease） |
| 3.2s | 工具① 读取文件 `~/meetings/*.md` · 4 个 |
| 4.0s | 工具② 检索记忆 `上季度周报格式` |
| 4.8s | 工具③ 写入文件 `weekly-report.md` |
| 5.7s | 产物卡片浮现（橙色边框） |
| 6.3s | 脉冲右→左回流（时长 1.3s） |
| 7.0s | 远端结果气泡：「已生成 weekly-report.md · 来自 MacBook Pro · **文件仍在本机**」 |

单元素入场：`opacity 0 → 1` + `translateY(7px) → 0`，`0.34s cubic-bezier(.22,.9,.28,1)`。

**三个必须保留的设计决定**：

1. **链路中必须画云端中转节点**，标注「云端 · 只过指令 · 不过数据」。消息实际经 `ws/im` device room 中转，画成点对点直连是**虚假宣传**。该节点同时把双轨架构讲清楚，是卖点而非短板。
2. **工具链恰为三步**。一步显不出"真在干活"，五步超出注意力窗口。
3. **结果气泡必须含「文件仍在本机」**。这句钉死 thesis 后半截：远程拿到的是结果，不是数据。

## 五、技术实现

**渲染**：`apps/web-main/src/app/page.tsx` 由 `"use client"` 重定向闸门改为 **Server Component 静态页**。web-main 无 middleware，`/` 天然公开，不涉及鉴权改造。

**删除的行为**：原「已登录→`/assistant`，未登录→`/login`」重定向整体移除。已登录用户此后进 `/` 看到落地页，经顶栏入口进应用。

**登录态 CTA**：token 存于 **localStorage**（`apps/web-main/src/lib/auth-storage.ts`），服务端渲染时无法获知登录状态。因此：

- hero 主 CTA「下载桌面端」**对所有人恒定**（已登录用户同样需要装桌面端），不参与切换
- 仅顶栏右上角次要入口切换，做成独立 client component，初始渲染**固定宽度骨架**，`useProfile` 到达后显示「登录」或「进入应用」
- 选骨架而非默认「登录」：向已登录用户展示「登录」是错误信息；固定宽度避免布局跳动（CLS）

**动画**：纯 CSS，只动 `transform` / `opacity`。**不引入 framer-motion**——原型已证明 CSS 足够，为单页加运行时依赖不划算。用 `IntersectionObserver` 使动画仅在首屏可见时播放，离开视口暂停。

**降级**：`prefers-reduced-motion: reduce` 下所有步骤静态直出，无位移无脉冲，**信息零丢失**。

**样式隔离**：landing 专属排版 token 就近置于 landing 目录并 scoped，**禁止写入 `packages/design`**。`packages/design` 是产品共享地基，落地页的排版冒险不得渗入。

**i18n**：按 `i18n-page` 规范，全部文案走 next-intl，新增 `landing` namespace；**zh 与 en 均按正式文案撰写**（GitHub 来源受众以英文为主）。写完执行 `pnpm sync:locales --write`。

## 六、下载 CTA 行为

主按钮指向 GitHub Releases latest，按 `navigator.userAgent` 探测平台推荐对应产物（mac / win / linux，`electron-builder.yml` 已配置三平台）。

**无 Release 时的兜底**：按钮降级为「查看源码」指向仓库，**不产生 404**。这保证落地页可早于 Release 上线而不说谎。

## 七、验收标准

风险分档：**低–中**（纯前端展示，无并发、无跨设备协议、无状态机）。不需要独立 reviewer。

- [ ] `web-design-guidelines` 技能审查通过（a11y / 焦点 / 语义 / 性能）
- [ ] Playwright 多断点截图：移动 375 / 平板 768 / 桌面 1440
- [ ] `prefers-reduced-motion: reduce` 下信息完整、无动画
- [ ] 键盘可达：所有 CTA 可 Tab 聚焦且焦点态清晰
- [ ] 未登录 / 已登录两态顶栏 CTA 正确，无布局跳动
- [ ] `pnpm sync:locales -- --check` 通过，zh / en 无缺 key
- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm build` 通过

## 八、范围外的前置依赖

以下均为**独立事项，不属本 spec**，但影响上线：

1. **首个 GitHub Release**（electron-builder 三平台产物、macOS 签名与公证、CI 发布流程、版本号策略）——落地页的**上线阻塞项**
2. **仓库缺 LICENSE**——README 自称开源，落地页将引流至仓库，上线前必须补齐
3. **README 第 44 行笔误**——写作「Next.js 15」，实际为 `^16.2.4`

## 九、明确不做

- 真·可玩 demo（需演示后端、限流、沙箱，成本与阶段不匹配）
- 产品截图墙、三步上手、完整架构图（见 §2）
- 亮色主题 / 主题切换
- Homebrew 等包管理器安装入口（当前不存在，不得在页面暗示）
