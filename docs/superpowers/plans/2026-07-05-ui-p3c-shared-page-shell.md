# UI 重构 P3c:共享 PageShell(视图/容器拆分) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 web-agent 的 `PageShell`(内容壳:响应式侧栏 + 内容卡)拆成"**共享纯展示 `PageShellView`** + **web-agent 薄容器 `PageShell`**",让 P4 的 web-main 能直接用同一个 `PageShellView`(自己写薄容器连自己的数据)。

**Architecture:** `PageShellView`(放 `@meshbot/web-common/shell`,纯展示)收全部展示 prop + 注入的 `drawerOpen`/`onCloseDrawer`/`sidebarRef`/`closeLabel`;web-agent 保留 `PageShell` 同名同签名的**薄容器**——读 `sidebarDrawerOpenAtom`(jotai)、`useShellRefs`(context)、`useTranslations("appShell")`,把这些喂给 `PageShellView`。**8 个 PageShell 消费者零改动**(容器签名不变)。`shell-refs-context` 留 web-agent(view 用 prop 收 ref,不用 context)。

**Tech Stack:** TypeScript(NodeNext)· React 19 · jotai · Tailwind v4。

## Global Constraints

- **落点 `@meshbot/web-common/shell`**(P3a 已建的源码直连子入口;`@source` P3a 已加,无需再加)。
- **PageShellView 纯展示**:只 `cn`(design)+ `react` 类型 + 注入 prop。**不引** atoms/rest/navigation/i18n。
- **容器/视图拆分**:web-agent `PageShell` 保持**同名 + 同 props 签名**(现有 8 个消费者不改),内部连数据后渲染 `PageShellView`。
- **零回归**:内容壳的侧栏(桌面常驻 / 窄屏抽屉 + 遮罩)、内容卡、滚动容器、padding 覆盖,行为/视觉与改前完全一致。
- **验证**:`pnpm --filter @meshbot/web-common typecheck` + `pnpm --filter @meshbot/web-agent typecheck`&`build` + 人工冒烟(各页侧栏+内容卡、窄屏抽屉开合)。
- 禁 `--no-verify`;中文 commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;分支 `feat/ui-p3a-shared-leaves`(P3a/P3b/P3c 同分支)。

## 依赖与命令
web-common typecheck:`pnpm --filter @meshbot/web-common typecheck`。web-agent:`pnpm --filter @meshbot/web-agent typecheck`/`build`(timeout 600000)。冒烟 `pnpm dev:web-agent`。

---

## File Structure

| 文件 | 改动 | 职责 |
|------|------|------|
| `packages/web-common/src/shell/page-shell-view.tsx` | 建 | 纯展示内容壳(props 全注入) |
| `packages/web-common/src/shell/index.ts` | 改 | 加 `PageShellView`/`PageShellViewProps` 导出 |
| `apps/web-agent/src/components/layouts/page-shell.tsx` | 改 | 变薄容器:连 atom/refs/i18n → 渲染 PageShellView |

---

## Task 1:建共享 `PageShellView`(web-agent 暂不动)

**Files:**
- Create: `packages/web-common/src/shell/page-shell-view.tsx`
- Modify: `packages/web-common/src/shell/index.ts`

- [ ] **Step 1:建 PageShellView** — 新建 `packages/web-common/src/shell/page-shell-view.tsx`(从 web-agent PageShell 的 JSX 原样搬,`t(...)`→`closeLabel`、`useShellRefs`→`sidebarRef` prop、`sidebarDrawerOpen`→`drawerOpen` prop、`setSidebarDrawerOpen(false)`→`onCloseDrawer`):

```tsx
"use client";

import { cn } from "@meshbot/design";
import type { ReactNode, RefObject } from "react";

export interface PageShellViewProps {
  /** 子导航侧栏;null/undefined = 不渲染侧栏。 */
  sidebar?: ReactNode | null;
  /** 内容卡顶部固定栏。 */
  header?: ReactNode;
  /** 暴露滚动容器 ref。 */
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  /** 覆盖内容包裹层默认内边距(p-4 lg:px-6)。 */
  contentClassName?: string;
  children: ReactNode;
  /** 侧栏元素 ref(dock 宽度 measure 用),容器经 context 取到后注入。 */
  sidebarRef?: RefObject<HTMLElement | null>;
  /** 窄屏抽屉是否打开(容器连 atom 注入)。 */
  drawerOpen: boolean;
  /** 关闭抽屉(点遮罩)。 */
  onCloseDrawer: () => void;
  /** 遮罩关闭按钮 aria-label(容器注入,i18n 解耦)。 */
  closeLabel: string;
}

/**
 * page 内容外壳(纯展示):侧栏(响应式抽屉)+ 内容卡(header + 滚动容器 + 内容)。
 * 数据(抽屉开关 / sidebarRef / i18n)由各 app 的薄容器注入。
 */
export function PageShellView({
  sidebar,
  header,
  scrollContainerRef,
  className,
  contentClassName,
  children,
  sidebarRef,
  drawerOpen,
  onCloseDrawer,
  closeLabel,
}: PageShellViewProps) {
  return (
    <>
      {sidebar && drawerOpen && (
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onCloseDrawer}
          className="absolute top-0 right-1.5 bottom-1.5 left-0 z-30 rounded-(--shell-radius) bg-black/50 md:hidden"
        />
      )}
      {sidebar && (
        <aside
          ref={sidebarRef}
          className={cn(
            "z-40 flex flex-col w-[240px] shrink-0 overflow-hidden bg-(--shell-sidebar) transition-transform duration-200",
            "absolute top-0 bottom-1.5 left-0 rounded-(--shell-radius) shadow-2xl",
            drawerOpen ? "translate-x-0" : "-translate-x-full",
            "md:static md:z-auto md:w-[240px] md:translate-x-0 md:rounded-r-none md:shadow-none md:transition-none",
          )}
        >
          {sidebar}
        </aside>
      )}
      <section
        className={cn(
          "relative flex min-w-0 flex-1 flex-col overflow-hidden bg-(--shell-content)",
          sidebar
            ? "rounded-(--shell-radius) md:rounded-l-none"
            : "rounded-(--shell-radius)",
        )}
      >
        {header}
        <div
          ref={scrollContainerRef}
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-y-auto",
            className,
          )}
        >
          <div
            className={cn(
              "flex w-full flex-1 flex-col",
              contentClassName ?? "p-4 lg:px-6",
            )}
          >
            {children}
          </div>
        </div>
      </section>
    </>
  );
}
```

- [ ] **Step 2:barrel 导出** — 在 `packages/web-common/src/shell/index.ts` 末尾加:

```ts
export { PageShellView, type PageShellViewProps } from "./page-shell-view";
```

- [ ] **Step 3:web-common typecheck**

Run:`pnpm --filter @meshbot/web-common typecheck`
Expected:PASS。

- [ ] **Step 4:确认 web-agent 未动 + 提交**

Run:`git status -s`(应只 `packages/web-common/*`)。
```bash
git add packages/web-common
git commit -m "feat(web-common): 新增共享 PageShellView(纯展示内容壳)

内容壳(响应式侧栏+内容卡)抽为纯展示,drawerOpen/onCloseDrawer/sidebarRef/closeLabel 注入。
web-agent 暂不动,下一 task 改薄容器。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2:web-agent PageShell 变薄容器(渲染 PageShellView)

**Files:**
- Modify: `apps/web-agent/src/components/layouts/page-shell.tsx`

**Interfaces:**
- Consumes:`PageShellView`(`@meshbot/web-common/shell`)、`sidebarDrawerOpenAtom`(`@/atoms/assistant-panel`)、`useShellRefs`(`./shell-refs-context`)、`useTranslations("appShell")`。
- Produces:`PageShell`(同名 + 同 props 签名,8 个消费者不变)。

- [ ] **Step 1:整体替换 `page-shell.tsx`** 为薄容器:

```tsx
"use client";

import { PageShellView, type PageShellViewProps } from "@meshbot/web-common/shell";
import { useAtom } from "jotai";
import { useTranslations } from "next-intl";
import { sidebarDrawerOpenAtom } from "@/atoms/assistant-panel";
import { useShellRefs } from "./shell-refs-context";

/** PageShell 对外 props:与旧签名一致(不含注入项——那些由容器补)。 */
type PageShellProps = Omit<
  PageShellViewProps,
  "sidebarRef" | "drawerOpen" | "onCloseDrawer" | "closeLabel"
>;

/**
 * 内容壳容器:连 drawer atom + shell refs + i18n,渲染共享 PageShellView。
 * 对外签名与旧 PageShell 一致,消费者无需改。
 */
export function PageShell(props: PageShellProps) {
  const t = useTranslations("appShell");
  const { sidebarRef } = useShellRefs();
  const [drawerOpen, setDrawerOpen] = useAtom(sidebarDrawerOpenAtom);
  return (
    <PageShellView
      {...props}
      sidebarRef={sidebarRef}
      drawerOpen={drawerOpen}
      onCloseDrawer={() => setDrawerOpen(false)}
      closeLabel={t("rail.messages")}
    />
  );
}
```

> 旧 `PageShell` 的 `PageShellProps` interface 被 `Omit<PageShellViewProps, …>` 取代;若有别处 `import type { PageShellProps }`,`grep -rn "PageShellProps" apps/web-agent/src`——旧文件未导出该类型(是本地 interface),应无外部引用;若有,改为从 view 派生或保留导出。

- [ ] **Step 2:typecheck + build**

Run:`pnpm --filter @meshbot/web-agent typecheck && pnpm --filter @meshbot/web-agent build`(timeout 600000)。Expected:PASS(8 个消费者签名不变,不应报错)。

- [ ] **Step 3:视觉冒烟(人工)** — `pnpm dev:web-agent`:各页(助手/消息/技能/网盘/流程/更多)的侧栏(桌面常驻)+ 内容卡渲染正常;窄屏(< md)缩窗:顶栏汉堡开侧栏抽屉、点遮罩关闭、切页自动收起,均与改前一致。

- [ ] **Step 4:提交**

```bash
git add apps/web-agent/src/components/layouts/page-shell.tsx
git commit -m "refactor(web-agent): PageShell 改薄容器,渲染共享 PageShellView

连 sidebarDrawerOpenAtom + useShellRefs + i18n 注入给共享 PageShellView;对外签名不变,
8 个消费者零改动。为 P4 web-main 用同一 PageShellView 铺路。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾
- [ ] **Step 1:全量围栏** — `pnpm typecheck && pnpm check`;Expected 全绿。
- [ ] **Step 2:确认 PageShellView 被消费** — `grep -rn "PageShellView" apps/web-agent/src`(容器 1 处)。

---

## Self-Review
**1. 覆盖**:PageShellView 纯展示共享 ✅;web-agent 薄容器同签名 ✅;shell-refs-context 留本地(view 用 prop 收 ref)✅;消费者零改 ✅;session-header/message-list 助手专属不抽(无 web-main 消费)✅。
**2. 占位符**:PageShellView 全码 + 容器全码给出;Step1 让实现者 grep `PageShellProps` 外部引用(旧是本地 interface,应无)——不臆造。
**3. 一致**:注入 prop 名(drawerOpen/onCloseDrawer/sidebarRef/closeLabel)在 view 定义与容器调用一致;JSX 从旧 PageShell 原样搬(类串不变)保零回归。
**4. 风险**:纯展示搬迁 + 容器薄封装,零回归靠"JSX 原样 + 签名不变";窄屏抽屉逻辑(drawerOpen/onClose)必须冒烟验(headless 测不了响应式)。

## 关于 P3d+/P4(后续)
P3d C 类 adapter 契约(rail/两 sidebar/dock/conversation-body——须先把取数拆 hook/adapter);P4 web-main 写自己的薄容器(rail/sidebar/PageShell)连 react-query,用上整套共享壳;P5 登录前。各自成 plan。
