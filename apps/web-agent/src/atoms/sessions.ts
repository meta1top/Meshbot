"use client";

import type { SessionStatus, SessionSummary } from "@meshbot/types-agent";
import {
  applySessionListEvent,
  type SessionListEvent,
} from "@meshbot/web-common/session/session-list-events";
import { atom } from "jotai";
import {
  deleteSession as deleteSessionApi,
  listSessions,
  patchSession,
} from "@/rest/session";

export type SessionsStatus = "idle" | "loading" | "loaded" | "error";

/** 全局会话列表（已排序）。任何写都走 sortSessions 重排。 */
export const sessionsAtom = atom<SessionSummary[]>([]);

/** 首屏加载状态。loaded 后永不再回 loading；新增/改/删全走局部 patch。 */
export const sessionsStatusAtom = atom<SessionsStatus>("idle");

/** 排序：updatedAt desc（置顶功能已移除）。 */
export function sortSessions(arr: SessionSummary[]): SessionSummary[] {
  return [...arr].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 首次加载（mount 时调）。已 loaded / loading 则 no-op。 */
export const loadSessionsAtom = atom(null, async (get, set) => {
  if (get(sessionsStatusAtom) !== "idle") return;
  set(sessionsStatusAtom, "loading");
  try {
    const arr = await listSessions();
    set(sessionsAtom, sortSessions(arr));
    set(sessionsStatusAtom, "loaded");
  } catch {
    set(sessionsStatusAtom, "error");
  }
});

/** 手动重试（错误态用）。无视当前 status，直接重拉。 */
export const reloadSessionsAtom = atom(null, async (_get, set) => {
  set(sessionsStatusAtom, "loading");
  try {
    const arr = await listSessions();
    set(sessionsAtom, sortSessions(arr));
    set(sessionsStatusAtom, "loaded");
  } catch {
    set(sessionsStatusAtom, "error");
  }
});

/**
 * 新建会话后插入。**必须按 id 幂等**，不能盲 push。
 *
 * 真机验收缺陷：本地建会话时侧栏出现两条。原因是同一条会话现在有**两条**到达
 * 路径——(1) REST `POST /api/sessions` 的响应，调用方拿到 summary 调本 atom；
 * (2) 服务端 `SessionService.createSession` 发的 `session.created`，经
 * `EventsGateway` → ws/events → `applySessionListEventAtom`。ws 是常驻连接，
 * 事件很容易**先于** HTTP 响应到达浏览器：事件那条按 id 查重（`applySessionListEvent`
 * 的 created 语义）不会插重，随后 REST 响应回来，旧实现的无条件 push 就插出了
 * 第二条。云端（web-main）没有这个问题，因为它只有事件这一条路径。
 *
 * 修法是复用 `applySessionListEventToArray` 而不是就地补一个 `some(id)` 判断：
 * 「一条会话进入列表」的合并语义只该有一份，两份实现迟早漂移，而漂移的那一半
 * 是「列表和真实状态不一致」这类极难复现的 bug。
 */
export const addSessionAtom = atom(
  null,
  (get, set, summary: SessionSummary) => {
    set(
      sessionsAtom,
      applySessionListEventToArray(get(sessionsAtom), {
        type: "created",
        session: summary,
      }),
    );
  },
);

/**
 * 重命名（乐观）。空标题或与原值相同：直接 no-op 不发请求。
 * 失败回滚到原 title + 抛错给调用方（让 UI 弹 toast）。
 *
 * 成功/失败路径都只 patch 自己改过的字段（title/titleGenerated），**不整体
 * 替换该行对象**——`status` 是 Session 的 DB 列，`runner.service.ts` 每次
 * run 起停都会经独立的 `updateSessionStatusAtom` patch 它；await 网络往返
 * 期间完全可能插入一次 status 变化。若整体替换：
 * - 失败回滚用的是 await **之前**拍的快照 `before`，会把这段窗口内发生的
 *   status 写入连带盖掉；
 * - 成功路径用服务端响应 `updated` 整体替换，而该响应是服务端在处理这次
 *   PATCH 请求时读回的快照，其 `status` 字段相对「此刻」同样可能过期。
 * `sessionsAtom` 首屏之后从不重拉（侧栏绿点全靠事件增量维持，见文件头
 * 注释），这类错误覆盖不会自愈，会一直挂到用户刷新页面——所以两条路径都改
 * 成读取 await 之后最新的 `get(sessionsAtom)`，只覆盖 title/titleGenerated
 * 这两个自己确实改过的字段，其余字段（包括 status）原样保留。
 */
export const renameSessionAtom = atom(
  null,
  async (get, set, params: { id: string; title: string }) => {
    const arr = get(sessionsAtom);
    const idx = arr.findIndex((s) => s.id === params.id);
    if (idx < 0) return;
    const before = arr[idx];
    const trimmed = params.title.trim();
    if (!trimmed || trimmed === before.title) return;
    const next = [...arr];
    next[idx] = { ...before, title: trimmed };
    set(sessionsAtom, sortSessions(next));
    try {
      const updated = await patchSession(params.id, { title: trimmed });
      const after = get(sessionsAtom).map((s) =>
        s.id === params.id
          ? {
              ...s,
              title: updated.title,
              titleGenerated: updated.titleGenerated,
            }
          : s,
      );
      set(sessionsAtom, sortSessions(after));
    } catch (err) {
      const rollback = get(sessionsAtom).map((s) =>
        s.id === params.id
          ? { ...s, title: before.title, titleGenerated: before.titleGenerated }
          : s,
      );
      set(sessionsAtom, sortSessions(rollback));
      throw err;
    }
  },
);

/**
 * 本设备正在主动删除中的会话 id 集合（短暂宽限期）。
 *
 * 用途：「当前打开的会话被删除 → 提示 + 跳转」这条逻辑（`use-global-events.ts`
 * 的 `onSessionListEvent`）需要分清「我自己删的」和「别的设备删的」——本设备
 * 发起删除时，服务端广播的 `session.deleted` 会经 `ws/events` **回声**给自己
 * （与 commit 79f0bd3c 修过的 `session.created` 双写同一根因：ws 是常驻连接，
 * 回声可能先于、也可能晚于 REST 响应到达，两种顺序在真实网络里都发生过，不能
 * 靠时序假设）。不区分的话，用户自己点删除也会弹出一句「该会话已在别处被
 * 删除」的误导提示。
 *
 * `deleteSessionAtom` 发起删除时把 id 记进来，`SELF_DELETE_GRACE_MS` 后自动
 * 清除；用定时器而非「REST 响应后立即清」，正是因为回声既可能早到也可能晚到，
 * 精确对齐 REST 时序不可靠，宽限几秒钟才能同时兜住两种顺序（本机 ws 回环延迟
 * 通常个位数毫秒，3s 绰绰有余，且这段宽限期不阻塞任何用户操作，过度保守没有
 * 代价）。
 */
export const selfDeletingSessionIdsAtom = atom<ReadonlySet<string>>(
  new Set<string>(),
);

/** {@link selfDeletingSessionIdsAtom} 的宽限期时长（ms），抽成常量供单测复用。 */
export const SELF_DELETE_GRACE_MS = 3000;

/**
 * 删除：等接口成功再从 list 移除（不做乐观更新）。
 *
 * 原因：调用方 SessionListItem 持有 dialog 的 deleting state；若乐观先移除，
 * SessionListItem 会立刻卸载，dialog 跟着销毁，用户看不到 loading + 失败回退
 * 等中间态。delete 是 destructive + 不可逆操作，慢一点（等服务端确认）比
 * 「闪一下」更可信。
 */
export const deleteSessionAtom = atom(null, async (get, set, id: string) => {
  if (!get(sessionsAtom).some((s) => s.id === id)) return;
  // 先标记「本设备正在删这条」（同步、先于任何网络 I/O），见
  // selfDeletingSessionIdsAtom 文档——保证这个标记严格 happens-before 服务端
  // 可能广播回来的 session.deleted 回声。
  set(selfDeletingSessionIdsAtom, (prev: ReadonlySet<string>) =>
    new Set(prev).add(id),
  );
  const clearMark = () => {
    set(selfDeletingSessionIdsAtom, (prev: ReadonlySet<string>) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };
  try {
    await deleteSessionApi(id);
  } catch (e) {
    // 删除失败：标记必须立刻清掉，否则这个 id 会一直被当成「本设备正在删」，
    // 之后若真的在别的设备被删，本机就收不到提示了。
    clearMark();
    throw e;
  }
  set(
    sessionsAtom,
    get(sessionsAtom).filter((s) => s.id !== id),
  );
  // **宽限计时锚在 REST 完成之后，不是点击那一刻**（review Important）。
  // 锚在点击时的失败场景：SQLite 写与正在跑的 run 抢锁（DataSource 设了
  // busy_timeout=5000，>3s 的写是够得着的，不是理论值）→ 宽限期 3s 先到期
  // → 服务端的 session.deleted 回声 3.5s 才落地 → 标记已经没了 → 用户为
  // **自己刚做的删除**吃一个「该会话已在其他设备被删除」的阻塞提示 + 一次跳转。
  // 锚在 REST 完成之后，宽限期覆盖的才是「回声在路上」这段真正需要保护的窗口。
  setTimeout(clearMark, SELF_DELETE_GRACE_MS);
});

/**
 * 按 id 局部 patch 会话运行状态；id 不在列表里则原样返回（引用不变）。
 *
 * 「存在才改」是硬要求：全局总线会广播所有会话的状态变更，其中随手问 quick /
 * 子 agent 会话本就不在侧栏列表里，插进去会凭空多出行。
 */
export function patchSessionStatus(
  arr: SessionSummary[],
  id: string,
  status: SessionStatus,
): SessionSummary[] {
  if (!arr.some((s) => s.id === id)) return arr;
  return arr.map((s) => (s.id === id ? { ...s, status } : s));
}

/**
 * 按 id 局部 patch session status（socket session.status_changed 收到时调）。
 * 侧栏「运行中」绿点靠它熄灭 —— sessionsAtom 首屏之后从不重拉。
 */
export const updateSessionStatusAtom = atom(
  null,
  (get, set, params: { id: string; status: SessionStatus }) => {
    const arr = get(sessionsAtom);
    const next = patchSessionStatus(arr, params.id, params.status);
    if (next === arr) return;
    set(sessionsAtom, next);
  },
);

/**
 * 会话生命周期事件（created 插入 / deleted 移除 / renamed 改标题）应用到列表，
 * 返回新数组；命中不到的会话（deleted/renamed）原样返回（引用不变）。
 *
 * 薄封装：合并逻辑委托 `@meshbot/web-common/session` 的 `applySessionListEvent`
 * ——与 web-main 远程 Agent 观察通道共用同一份归并（spec D9「上层处理逻辑一份」，
 * 不重复实现，两份实现漂移是「会话列表和真实状态不一致」这类极难复现 bug 的
 * 根因）。这里只加一层 sortSessions 保持列表顺序不变式（其余改动列表的 atom
 * 都在写入前重排）；独立抽成纯函数是为了不依赖 jotai store 就能单测。
 */
export function applySessionListEventToArray(
  arr: SessionSummary[],
  evt: SessionListEvent,
): SessionSummary[] {
  const next = applySessionListEvent(arr, evt);
  return next === arr ? arr : sortSessions(next);
}

/**
 * 全局事件总线收到 session.created/deleted/renamed（`EventsGateway` 转发的
 * 本地会话生命周期事件）时调用，落 sessionsAtom。
 *
 * `status_changed` 不走这条路径——它有独立的处理入口 `updateSessionStatusAtom`
 * （「存在才改」的语义与这里的 created 会插入新行不同，硬拆开更清楚，见该
 * atom 文档），继续保持现状，不在此处顺带合并。
 */
export const applySessionListEventAtom = atom(
  null,
  (get, set, evt: SessionListEvent) => {
    const arr = get(sessionsAtom);
    const next = applySessionListEventToArray(arr, evt);
    if (next !== arr) set(sessionsAtom, next);
  },
);

/**
 * 按 id 局部 patch session title + titleGenerated=true。
 * socket session.title_updated 收到 + 未来「重生成标题」入口共用。
 */
export const updateSessionTitleAtom = atom(
  null,
  (get, set, params: { id: string; title: string }) => {
    const arr = get(sessionsAtom);
    if (!arr.some((s) => s.id === params.id)) return;
    set(
      sessionsAtom,
      sortSessions(
        arr.map((s) =>
          s.id === params.id
            ? { ...s, title: params.title, titleGenerated: true }
            : s,
        ),
      ),
    );
  },
);
