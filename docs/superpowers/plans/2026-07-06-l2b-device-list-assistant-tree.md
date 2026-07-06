# L2b · 设备列表 + 助手两级树 + 本地会话 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** web-agent「助手」侧栏改为两级树 —— 一级列该账号所有注册设备(本机 A + 其他设备 B/C，带在线点)，展开本机 → 列其本地 agent 工作会话；composer「选择 agent」用同一份设备列表。

**Architecture:** 云端 `GET /api/devices` 加 `isCurrent`(device token 请求下 = 本机)。server-agent 薄代理 devices/online 到云端(deviceToken)。web-agent 用 atom 载入设备列表(与侧栏会话同套模式)：本机节点展开走现成本地会话(`sessionsAtom`)，其他设备**仅列出 + 在线点**（展开查看其会话属 L2c，此处占位提示）。

**Tech Stack:** NestJS · TypeORM · Next.js · jotai · @tanstack/react-query(web-main) · next-intl · Tailwind · Biome · Jest。

## Global Constraints

- 前置 L2a(移除 Agent-DM)已在本分支完成。**保留**普通 IM + 设备在线态(`DevicePresenceService` / `GET /api/devices/:id/online`)。
- 用户可见字符串走 next-intl，禁裸字符串(`i18n-page`)；新键中英齐全、过 pre-commit i18n 对齐(`missing=0 asymmetric=0`)。
- 每任务末：`pnpm typecheck` 退出码 0 + 相关 `pnpm test`/`pnpm check` + Biome。
- web-agent 无 React 组件测试 runner(已确认)；UI 任务验收 = typecheck + Biome + 桌面端目视(`pnpm dev:desktop`)。CSS 若陈旧 → `rm -rf apps/web-agent/.next` 重启。
- 云端 REST 的 `@CurrentUser`：device token 请求携带 `deviceId`（`JwtMainPayload.deviceId`，JwtAuthGuard device 分支填充）；用户 JWT 请求 `deviceId` 为 undefined。
- **L2b 只读列举**：其他设备的会话内容拉取属 L2c，本 plan 不做（其他设备节点仅列出 + 在线点 + 占位）。
- 提交中文 conventional commits，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

## 文件结构

| 动作 | 文件 | 职责 |
|---|---|---|
| 改 | `libs/types/src/device-auth/device-auth.schema.ts` | `DeviceView` 加 `isCurrent: boolean` |
| 改 | `apps/server-main/src/rest/device.controller.ts` | `list` 映射 `isCurrent: d.id === u.deviceId` |
| 改 | `apps/server-agent/src/services/cloud-im.service.ts` | 加 `listDevices()` / `deviceOnline(id)` 代理 |
| 改 | `apps/server-agent/src/controllers/cloud-im.controller.ts` | 加 `GET /api/devices` / `GET /api/devices/:id/online` |
| 建 | `apps/web-agent/src/rest/devices.ts` | `fetchDevices()` / `fetchDeviceOnline(id)` |
| 建 | `apps/web-agent/src/atoms/devices.ts` | `devicesAtom` / `devicesStatusAtom` / `loadDevicesAtom` |
| 建 | `apps/web-agent/src/components/shell/device-node.tsx` | 两级树的单个设备节点(展开/在线点/会话) |
| 改 | `apps/web-agent/src/components/shell/assistant-sidebar.tsx` | 改为设备两级树 |
| 改 | `apps/web-agent/src/components/home/composer-target-bar.tsx` | 「选择 agent」列真实设备 |
| 改 | `apps/web-agent/messages/{zh,en}.json` | 新增文案键 |

---

## Task 1: 云端 DeviceView 加 isCurrent

**Files:**
- Modify: `libs/types/src/device-auth/device-auth.schema.ts`（`DeviceView` interface）
- Modify: `apps/server-main/src/rest/device.controller.ts`（`list`）
- Test: `apps/server-main/test/device-controller.routes.spec.ts`（若存在则加断言；否则靠 typecheck）

**Interfaces:**
- Produces: `DeviceView.isCurrent: boolean`。device token 请求(server-agent 代理) → 本机那台 `true`；用户 JWT(web-main) → 全 `false`。

- [ ] **Step 1: DeviceView 加字段**

在 `libs/types/src/device-auth/device-auth.schema.ts` 的 `DeviceView` 末尾加：
```ts
export interface DeviceView {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** 该设备是否为当前请求方设备（device token 请求时判定；用户 JWT 请求恒 false）。 */
  isCurrent: boolean;
}
```

- [ ] **Step 2: device.controller.list 映射 isCurrent**

`apps/server-main/src/rest/device.controller.ts` 的 `list` 返回映射加 `isCurrent`：
```ts
  @Get()
  async list(@CurrentUser() u: JwtMainPayload): Promise<DeviceView[]> {
    const rows = await this.devices.listByUser(u.userId);
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
      revokedAt: d.revokedAt ? d.revokedAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
      isCurrent: d.id === u.deviceId,
    }));
  }
```

- [ ] **Step 3: 校验**

Run:
```bash
npx tsc --noEmit -p apps/server-main/tsconfig.json
pnpm test 2>&1 | tail -5
```
Expected: tsc 0；测试全绿(web-main `useDevices` 消费者拿到多一个字段，向后兼容；如有 device controller 测试断言了 DeviceView 形状，补 `isCurrent: false`)。

- [ ] **Step 4: Biome + 提交**

```bash
npx biome check --write libs/types/src apps/server-main/src
git add -A libs/types apps/server-main/src
git commit -m "feat(server-main): DeviceView 加 isCurrent(device token 请求标本机)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: server-agent 代理 devices / online

**Files:**
- Modify: `apps/server-agent/src/services/cloud-im.service.ts`
- Modify: `apps/server-agent/src/controllers/cloud-im.controller.ts`

**Interfaces:**
- Consumes: 云端 `GET /api/devices`(带 isCurrent)、`GET /api/devices/:id/online`。
- Produces: 本地 `GET /api/devices` → `DeviceView[]`；本地 `GET /api/devices/:id/online` → `{ online: boolean }`。web-agent 经此拿云端设备(deviceToken 由 CloudImService 注入)。

- [ ] **Step 1: CloudImService 加两个代理方法**

`apps/server-agent/src/services/cloud-im.service.ts` 顶部 import 补 `DeviceView`：
```ts
import type {
  ChannelMember,
  ConversationSummary,
  DeviceView,
  MessagePage,
} from "@meshbot/types";
```
在类内(如 `listConversations` 附近)加：
```ts
  /** 该账号在云端注册的全部设备（含 isCurrent 标本机）。 */
  listDevices(): Promise<DeviceView[]> {
    return this.withToken((token) =>
      this.cloud.get<DeviceView[]>("/api/devices", token),
    );
  }

  /** 查某设备在线态。 */
  deviceOnline(deviceId: string): Promise<{ online: boolean }> {
    return this.withToken((token) =>
      this.cloud.get<{ online: boolean }>(
        `/api/devices/${deviceId}/online`,
        token,
      ),
    );
  }
```

- [ ] **Step 2: CloudImController 加两个路由**

`apps/server-agent/src/controllers/cloud-im.controller.ts` 顶部 import 补 `DeviceView`（与 ConversationSummary 同 import 块）；类内加：
```ts
  /** 该账号云端注册设备列表（含 isCurrent）。 */
  @Get("devices")
  listDevices(): Promise<DeviceView[]> {
    return this.cloudIm.listDevices();
  }

  /** 某设备在线态。 */
  @Get("devices/:id/online")
  deviceOnline(@Param("id") id: string): Promise<{ online: boolean }> {
    return this.cloudIm.deviceOnline(id);
  }
```

- [ ] **Step 3: 校验**

Run:
```bash
npx tsc --noEmit -p apps/server-agent/tsconfig.json
pnpm test 2>&1 | tail -5
pnpm check:repo
```
Expected: tsc 0；测试全绿；check:repo 绿(CloudImController 不注入 Repo，仍走 CloudImService)。

- [ ] **Step 4: Biome + 提交**

```bash
npx biome check --write apps/server-agent/src
git add -A apps/server-agent/src
git commit -m "feat(server-agent): 云代理 GET /api/devices 与 /devices/:id/online

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: web-agent rest/devices + devices atom

**Files:**
- Create: `apps/web-agent/src/rest/devices.ts`
- Create: `apps/web-agent/src/atoms/devices.ts`

**Interfaces:**
- Produces:
  - `fetchDevices(): Promise<DeviceView[]>`、`fetchDeviceOnline(id: string): Promise<boolean>`。
  - `devicesAtom: PrimitiveAtom<DeviceView[]>`、`devicesStatusAtom: PrimitiveAtom<"idle"|"loading"|"loaded"|"error">`、`loadDevicesAtom`(write-only，含 guard)。
- Consumes: Task 2 的本地代理端点。

- [ ] **Step 1: rest/devices.ts**

创建 `apps/web-agent/src/rest/devices.ts`：
```ts
"use client";

import type { DeviceView } from "@meshbot/types";
import { apiClient } from "@meshbot/web-common";

/** 该账号云端注册设备列表（经本地 server-agent 代理，含 isCurrent）。 */
export async function fetchDevices(): Promise<DeviceView[]> {
  const { data } = await apiClient.get<DeviceView[]>("/api/devices");
  return data;
}

/** 查某设备在线态。 */
export async function fetchDeviceOnline(deviceId: string): Promise<boolean> {
  const { data } = await apiClient.get<{ online: boolean }>(
    `/api/devices/${deviceId}/online`,
  );
  return data.online;
}
```

- [ ] **Step 2: atoms/devices.ts**

创建 `apps/web-agent/src/atoms/devices.ts`：
```ts
"use client";

import type { DeviceView } from "@meshbot/types";
import { atom } from "jotai";
import { fetchDeviceOnline, fetchDevices } from "@/rest/devices";

export type DevicesStatus = "idle" | "loading" | "loaded" | "error";

/** 该账号所有注册设备（本机 isCurrent=true 排最前）。 */
export const devicesAtom = atom<DeviceView[]>([]);
export const devicesStatusAtom = atom<DevicesStatus>("idle");
/** deviceId → 在线态（首屏并发探测填充）。 */
export const deviceOnlineAtom = atom<Record<string, boolean>>({});

/** 载入设备列表 + 并发探测在线态；guard：已加载/加载中不重复拉。 */
export const loadDevicesAtom = atom(null, async (get, set) => {
  if (get(devicesStatusAtom) !== "idle") return;
  set(devicesStatusAtom, "loading");
  try {
    const devices = await fetchDevices();
    // 本机排最前，其余按名称
    const sorted = [...devices].sort((a, b) =>
      a.isCurrent === b.isCurrent
        ? a.name.localeCompare(b.name)
        : a.isCurrent
          ? -1
          : 1,
    );
    set(devicesAtom, sorted);
    set(devicesStatusAtom, "loaded");
    // 在线态并发探测（失败按离线处理，不阻塞列表）
    const entries = await Promise.all(
      sorted
        .filter((d) => !d.revokedAt)
        .map(async (d) => {
          try {
            return [d.id, await fetchDeviceOnline(d.id)] as const;
          } catch {
            return [d.id, false] as const;
          }
        }),
    );
    set(deviceOnlineAtom, Object.fromEntries(entries));
  } catch {
    set(devicesStatusAtom, "error");
  }
});
```

- [ ] **Step 3: 校验 + 提交**

Run: `npx tsc --noEmit -p apps/web-agent/tsconfig.json`（退出码 0）
```bash
npx biome check --write apps/web-agent/src/rest/devices.ts apps/web-agent/src/atoms/devices.ts
git add apps/web-agent/src/rest/devices.ts apps/web-agent/src/atoms/devices.ts
git commit -m "feat(web-agent): 设备列表 rest + atom（本机置顶 + 在线态并发探测）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 助手侧栏改设备两级树

**Files:**
- Create: `apps/web-agent/src/components/shell/device-node.tsx`
- Modify: `apps/web-agent/src/components/shell/assistant-sidebar.tsx`
- Modify: `apps/web-agent/messages/zh.json` / `en.json`（`assistantSidebar` 段补键）

**Interfaces:**
- Consumes: `devicesAtom` / `devicesStatusAtom` / `deviceOnlineAtom`（Task 3）、`sessionsAtom` / `sessionsStatusAtom`（现有）、`loadSidebarAtom`（现有）、`loadDevicesAtom`（Task 3）、`SessionListItem`（现有）。

- [ ] **Step 1: 新增文案键（zh + en，`assistantSidebar` 段内）**

zh.json 的 `assistantSidebar` 段加：
```json
    "thisDeviceLabel": "本机",
    "offline": "离线",
    "remoteComingSoon": "远程会话查看即将支持",
    "devicesLoadFailed": "设备列表加载失败"
```
en.json 对应：
```json
    "thisDeviceLabel": "This device",
    "offline": "Offline",
    "remoteComingSoon": "Remote sessions coming soon",
    "devicesLoadFailed": "Failed to load devices"
```
校验键集对称：
```bash
node -e 'const z=require("./apps/web-agent/messages/zh.json").assistantSidebar,e=require("./apps/web-agent/messages/en.json").assistantSidebar;const d=Object.keys(z).filter(k=>!(k in e)).concat(Object.keys(e).filter(k=>!(k in z)));console.log(d.length?"MISMATCH "+d:"OK")'
```
Expected: `OK`

- [ ] **Step 2: device-node.tsx（单个设备节点：头 + 展开体）**

创建 `apps/web-agent/src/components/shell/device-node.tsx`：
```tsx
"use client";

import type { DeviceView } from "@meshbot/types";
import { SidebarSkeleton } from "@meshbot/web-common/shell";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { sessionsAtom, sessionsStatusAtom } from "@/atoms/sessions";
import { SessionListItem } from "@/components/sidebar/session-list-item";

/**
 * 助手两级树的一级节点：一台设备（agent）。
 * - 本机（isCurrent）：展开列本地会话（sessionsAtom）；默认展开。
 * - 其他设备：展开占位「远程会话查看即将支持」（L2c 接实时拉取）；离线置灰不可展开。
 */
export function DeviceNode({
  device,
  online,
}: {
  device: DeviceView;
  online: boolean;
}) {
  const t = useTranslations("assistantSidebar");
  const [open, setOpen] = useState(device.isCurrent);
  const sessions = useAtomValue(sessionsAtom);
  const sessionsStatus = useAtomValue(sessionsStatusAtom);
  const canExpand = device.isCurrent || online;
  const label = device.isCurrent
    ? `${device.name}（${t("thisDeviceLabel")}）`
    : device.name;

  return (
    <div className="mb-1">
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] font-semibold text-(--shell-sidebar-fg) transition-colors hover:bg-(--shell-sidebar-hover) disabled:opacity-50"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
        )}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-[#16a34a]" : "bg-(--shell-sidebar-fg)/30"}`}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {!online && !device.isCurrent && (
          <span className="shrink-0 text-[11px] text-(--shell-sidebar-fg)/50">
            {t("offline")}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-4 border-(--shell-line) border-l pl-1.5">
          {device.isCurrent ? (
            sessionsStatus === "idle" || sessionsStatus === "loading" ? (
              <SidebarSkeleton />
            ) : sessions.length === 0 ? (
              <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
                {t("empty")}
              </div>
            ) : (
              sessions.map((s) => <SessionListItem key={s.id} session={s} />)
            )
          ) : (
            <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
              {t("remoteComingSoon")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 重写 assistant-sidebar.tsx**

替换 `apps/web-agent/src/components/shell/assistant-sidebar.tsx` 全文：
```tsx
"use client";

import { SidebarSkeleton } from "@meshbot/web-common/shell";
import { useAtomValue, useSetAtom } from "jotai";
import { SquarePen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import {
  deviceOnlineAtom,
  devicesAtom,
  devicesStatusAtom,
  loadDevicesAtom,
} from "@/atoms/devices";
import { loadSidebarAtom } from "@/atoms/sidebar";
import { DeviceNode } from "@/components/shell/device-node";

/**
 * 助手二级侧栏：设备两级树。一级=该账号所有注册设备（本机 + 其他，带在线点），
 * 展开本机 → 本地会话；其他设备展开为占位（远程查看属 L2c）。
 * 本地会话经 loadSidebarAtom 载入（sessionsAtom），设备列表经 loadDevicesAtom 载入。
 */
export function AssistantSidebar() {
  const t = useTranslations("assistantSidebar");
  const router = useRouter();
  const devices = useAtomValue(devicesAtom);
  const devicesStatus = useAtomValue(devicesStatusAtom);
  const online = useAtomValue(deviceOnlineAtom);
  const loadDevices = useSetAtom(loadDevicesAtom);
  const loadSidebar = useSetAtom(loadSidebarAtom);

  useEffect(() => {
    void loadSidebar();
    void loadDevices();
  }, [loadSidebar, loadDevices]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between px-3">
        <span className="text-[15px] font-extrabold">{t("title")}</span>
        <button
          type="button"
          title={t("newSession")}
          onClick={() => router.push("/assistant")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-(--shell-sidebar-fg)/70 transition-colors hover:bg-(--shell-sidebar-hover) hover:text-(--shell-sidebar-fg)"
        >
          <SquarePen className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        {devicesStatus === "idle" || devicesStatus === "loading" ? (
          <SidebarSkeleton />
        ) : devicesStatus === "error" ? (
          <div className="px-2 py-1 text-[12px] text-(--shell-sidebar-fg)/55">
            {t("devicesLoadFailed")}
          </div>
        ) : (
          devices
            .filter((d) => !d.revokedAt)
            .map((d) => (
              <DeviceNode
                key={d.id}
                device={d}
                online={d.isCurrent || (online[d.id] ?? false)}
              />
            ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 校验**

Run:
```bash
npx tsc --noEmit -p apps/web-agent/tsconfig.json
npx biome check --write apps/web-agent/src apps/web-agent/messages
```
Expected: tsc 0；Biome 无 error。

- [ ] **Step 5: 目视（桌面端 Cmd+R）**

助手侧栏：一级列出设备（本机在最前、带「本机」+ 绿点、默认展开列本地会话；其他设备带在线/离线点，离线置灰不可展开，在线展开显「远程会话查看即将支持」）。

- [ ] **Step 6: 提交**

```bash
git add apps/web-agent/src/components/shell/device-node.tsx apps/web-agent/src/components/shell/assistant-sidebar.tsx apps/web-agent/messages
git commit -m "feat(web-agent): 助手侧栏改设备两级树（本机会话 + 其他设备列举/在线点）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: composer「选择 agent」接真实设备列表

**Files:**
- Modify: `apps/web-agent/src/components/home/composer-target-bar.tsx`
- Modify: `apps/web-agent/messages/zh.json` / `en.json`（如需新键）

**Interfaces:**
- Consumes: `devicesAtom` / `deviceOnlineAtom` / `loadDevicesAtom`（Task 3）。L2b 阶段选中项仅记录本地 state（新建任务默认发本机；选其他设备的远程执行属 L3，此处仅展示/占位）。

- [ ] **Step 1: 改 composer-target-bar.tsx 的「选择 agent」为设备下拉**

将 `ComposerTargetBar` 里「选择 agent」那颗按钮替换为 Dropdown（用 `@meshbot/design` 的 `DropdownMenu`，与 workspace-sidebar 用户菜单同套）：加载 `loadDevicesAtom`，触发器显示当前选中设备名（默认本机 isCurrent），下拉列 `devicesAtom` 各设备（离线置灰、带在线点）。选中仅存本地 state（`useState`）。「选择工作空间」保持原占位不动。

参考结构（替换原「选择 Agent」按钮块，保留「选择工作空间」按钮块与外层容器）：
```tsx
"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@meshbot/design";
import { useAtomValue, useSetAtom } from "jotai";
import {
  ChevronRight,
  FolderClosed,
  MonitorSmartphone,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import {
  deviceOnlineAtom,
  devicesAtom,
  loadDevicesAtom,
} from "@/atoms/devices";

/** 起手台 composer 下方目标选择器行：选择 Agent（默认本机，列该账号所有设备）+ 选择工作空间（占位）。 */
export function ComposerTargetBar() {
  const t = useTranslations("composer");
  const devices = useAtomValue(devicesAtom);
  const online = useAtomValue(deviceOnlineAtom);
  const loadDevices = useSetAtom(loadDevicesAtom);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const local = useMemo(() => devices.find((d) => d.isCurrent), [devices]);
  const selected =
    devices.find((d) => d.id === selectedId) ?? local ?? null;
  const selectedLabel = selected
    ? selected.isCurrent
      ? t("agentLocal")
      : selected.name
    : t("agentLocal");

  return (
    <div className="mt-2 flex items-center gap-4 px-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <MonitorSmartphone className="h-3.5 w-3.5" />
            {selectedLabel}
            <ChevronRight className="h-3 w-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[180px]">
          {devices
            .filter((d) => !d.revokedAt)
            .map((d) => {
              const isOnline = d.isCurrent || (online[d.id] ?? false);
              return (
                <DropdownMenuItem
                  key={d.id}
                  disabled={!isOnline}
                  onClick={() => setSelectedId(d.id)}
                  className="flex items-center gap-2"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? "bg-[#16a34a]" : "bg-muted-foreground/40"}`}
                  />
                  <span className="truncate">
                    {d.isCurrent ? t("agentLocal") : d.name}
                  </span>
                </DropdownMenuItem>
              );
            })}
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        title={t("comingSoon")}
        className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <FolderClosed className="h-3.5 w-3.5" />
        {t("workspaceDefault")}
        <ChevronRight className="h-3 w-3 opacity-60" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: 校验**

Run:
```bash
npx tsc --noEmit -p apps/web-agent/tsconfig.json
npx biome check --write apps/web-agent/src/components/home/composer-target-bar.tsx
```
Expected: tsc 0；Biome 无 error。（`composer.agentLocal` / `comingSoon` / `workspaceDefault` 键 L1 已存在，无需补键。）

- [ ] **Step 3: 目视**

起手台 composer 下方「选择 agent」下拉列出该账号所有设备（本机=「本地」置顶带绿点默认选中；其他设备离线置灰）。

- [ ] **Step 4: 提交**

```bash
git add apps/web-agent/src/components/home/composer-target-bar.tsx
git commit -m "feat(web-agent): composer 选择 agent 接真实设备列表（与助手侧栏同源）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review（作者已过一遍）

- **Spec 覆盖(L2b)**：设备列表(GET /api/devices + isCurrent) → Task1/2；web-agent 取数 → Task3；助手两级树(本机会话 + 其他设备列举 + 在线点) → Task4；composer 选择器同源 → Task5。「B/C 会话只读拉取」明确属 L2c，本 plan 只列举 + 占位。
- **占位扫描**：无 TBD；每步给了完整代码/命令/预期。
- **类型一致**：`DeviceView.isCurrent`(Task1 定义) → Task2 代理透传 → Task3 atom/rest → Task4/5 消费，签名一致；`devicesAtom/devicesStatusAtom/deviceOnlineAtom/loadDevicesAtom`(Task3 定义) → Task4/5 消费一致；`fetchDevices/fetchDeviceOnline`(Task3) 一致。
- **在线态**：L2b 用首屏 REST 并发探测（`loadDevicesAtom`）；实时 presence 订阅未做（后续 polish，不阻塞 L2b）。
- **测试基建**：backend(Task1/2) 有 jest；web-agent(Task3-5) 无组件测试 runner → typecheck + Biome + 目视。
- **依赖顺序**：Task1(云端字段)→Task2(代理)→Task3(rest/atom)→Task4/5(UI)。每任务末 typecheck 卡关。
```
