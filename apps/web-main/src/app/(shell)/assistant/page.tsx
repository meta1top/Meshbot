"use client";

import { PageShellView } from "@meshbot/web-common/shell";
import { Bot } from "lucide-react";
import { useTranslations } from "next-intl";

/** 助手区主区空态：未选中会话时提示从左侧树选设备/会话。侧栏树由段
 * layout 的 `AssistantSidebar` 持久渲染。 */
export default function AssistantPage() {
  const t = useTranslations("assistant");
  return (
    <PageShellView>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--shell-accent)/12 text-(--shell-accent)">
          <Bot className="h-7 w-7" />
        </span>
        <div className="text-[15px] font-semibold text-foreground">
          {t("selectDeviceTitle")}
        </div>
        <div className="max-w-[320px] text-[13px] text-muted-foreground">
          {t("selectDeviceHint")}
        </div>
      </div>
    </PageShellView>
  );
}
