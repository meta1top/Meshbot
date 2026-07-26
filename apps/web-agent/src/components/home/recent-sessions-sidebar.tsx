"use client";

import { SidebarHeader } from "@meshbot/web-common/shell";
import { useAtomValue, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { sessionsAtom } from "@/atoms/sessions";
import { loadSidebarAtom } from "@/atoms/sidebar";
import { SessionListItem } from "@/components/sidebar/session-list-item";

/**
 * 起手台首页左栏:最近会话列表(portal 进 WorkspaceSidebar,浅底继承,不带
 * 自身背景,与 Phase 1 各子栏一致)。数据与助手侧栏共用 loadSidebarAtom
 * (一次请求填会话+助手,带 guard 不重复拉取)。
 *
 * 只有单一分组(与 header 同为「最近」),不再嵌套 SidebarSection 造成标题重复。
 */
export function RecentSessionsSidebar() {
  const t = useTranslations("home");
  const sessions = useAtomValue(sessionsAtom);
  const loadSidebar = useSetAtom(loadSidebarAtom);

  useEffect(() => {
    void loadSidebar();
  }, [loadSidebar]);

  return (
    <div className="flex h-full flex-col">
      <SidebarHeader title={t("recent")} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
        {sessions.map((s) => (
          // depth=1：与助手树里 agent 展开后的会话条目同一缩进节奏（内容左移
          // 22px），否则图标贴容器左缘、整列显得又挤又秃（用户验收反馈）。
          <SessionListItem key={s.id} session={s} depth={1} />
        ))}
      </div>
    </div>
  );
}
