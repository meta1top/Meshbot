"use client";

import { PageShellView } from "@meshbot/web-common/shell";
import { Bot } from "lucide-react";
import { useTranslations } from "next-intl";
import { DeviceSublist } from "@/components/assistant/device-sublist";

/** 助手区主区空态：未选中设备时提示从左侧子栏选择。设备列表本身由
 * `DeviceSublist` portal 进二级子栏渲染。 */
export default function AssistantPage() {
  const t = useTranslations("assistant");
  return (
    <>
      <DeviceSublist />
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
    </>
  );
}
