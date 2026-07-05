"use client";

import {
  PageShellView,
  type PageShellViewProps,
} from "@meshbot/web-common/shell";
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
