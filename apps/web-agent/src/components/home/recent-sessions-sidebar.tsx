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
 * 行节奏与助手树会话条目一致:space-y-0.5 行间距(SidebarNav 同款);滚动容器用
 * block 而非 flex-col,溢出时行高不被 flex 压缩(用户验收反馈的行高塌缩 bug)。
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
      {/* block 而非 flex-col：flex 列容器溢出时会先把 h-7 行压扁到最小内容高度
          再出滚动条（行高塌缩 bug 根因），block 子元素不参与 flex 压缩。 */}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        {showSkeleton &&
          [0, 1, 2, 3, 4].map((i) => (
            // 形状贴近真实行:h-7 行高 + 与真实行同款左内边距
            <div key={i} className="flex h-7 shrink-0 items-center pl-2 pr-2">
              <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-sm bg-(--shell-sidebar-fg)/8" />
              <Skeleton
                className={cn(
                  "ml-2 h-3 rounded-sm bg-(--shell-sidebar-fg)/8",
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
          <SessionListItem key={s.id} session={s} />
        ))}
      </div>
    </div>
  );
}
