"use client";

import { cn, Skeleton } from "@meshbot/design";
import { SidebarHeader } from "@meshbot/web-common/shell";
import { useAtomValue, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { sessionsAtom, sessionsStatusAtom } from "@/atoms/sessions";
import { loadSidebarAtom } from "@/atoms/sidebar";
import { SessionListItem } from "@/components/sidebar/session-list-item";

/**
 * 起手台首页左栏:最近会话列表(portal 进 WorkspaceSidebar,浅底继承,不带
 * 自身背景,与 Phase 1 各子栏一致)。数据与助手侧栏共用 loadSidebarAtom
 * (一次请求填会话+助手,带 guard 不重复拉取)。
 *
 * 只有单一分组(与 header 同为「最近」),不再嵌套 SidebarSection 造成标题重复。
 * 行节奏与助手树会话条目对齐:同 depth=1 缩进 + space-y-0.5 行间距
 * (SidebarNav 同款),两处列表读起来是同一套(用户验收反馈)。
 */
export function RecentSessionsSidebar() {
  const t = useTranslations("home");
  const sessions = useAtomValue(sessionsAtom);
  const status = useAtomValue(sessionsStatusAtom);
  const loadSidebar = useSetAtom(loadSidebarAtom);

  useEffect(() => {
    void loadSidebar();
  }, [loadSidebar]);

  // 首载骨架:仅在「尚无任何数据」时显示(loaded 前 WS 可能已填充部分会话,
  // 有数据就直接渲染,刷新静默——加载态规范第 3 条)。
  const showSkeleton = status !== "loaded" && sessions.length === 0;
  const showEmpty = status === "loaded" && sessions.length === 0;

  return (
    <div className="flex h-full flex-col">
      <SidebarHeader title={t("recent")} />
      <div className="flex min-h-0 flex-1 flex-col space-y-0.5 overflow-y-auto px-3 py-2">
        {showSkeleton &&
          [0, 1, 2, 3, 4].map((i) => (
            // 形状贴近真实行:h-7 行高 + depth=1 同款缩进(8+14=22px)
            <div key={i} className="flex h-7 items-center pl-5.5 pr-2">
              <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-sm" />
              <Skeleton
                className={cn(
                  "ml-2 h-3 rounded-sm",
                  ["w-3/5", "w-4/5", "w-1/2", "w-2/3", "w-3/4"][i],
                )}
              />
            </div>
          ))}
        {showEmpty && (
          <p className="px-2 py-3 text-[12px] text-(--shell-sidebar-fg)/50">
            {t("noRecentSessions")}
          </p>
        )}
        {sessions.map((s) => (
          // depth=1:与助手树里 agent 展开后的会话条目同一缩进节奏
          <SessionListItem key={s.id} session={s} depth={1} />
        ))}
      </div>
    </div>
  );
}
