"use client";

import { MessagesSquare } from "lucide-react";
import { useTranslations } from "next-intl";

/** `/messages` 空态：未选中任何会话时的占位，引导从侧栏选/新建一个 Agent 会话。 */
export default function MessagesPage() {
  const t = useTranslations("messages");

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <MessagesSquare className="h-10 w-10 text-muted-foreground/50" />
      <div className="text-[15px] font-semibold text-foreground">
        {t("empty.title")}
      </div>
      <div className="max-w-sm text-sm text-muted-foreground">
        {t("empty.description")}
      </div>
    </div>
  );
}
