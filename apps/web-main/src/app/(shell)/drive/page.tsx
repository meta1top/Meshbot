"use client";
import { Folder } from "lucide-react";
import { useTranslations } from "next-intl";

export default function DrivePage() {
  const t = useTranslations("shellStub");
  return (
    <div className="flex h-full items-center justify-center rounded-(--shell-radius) bg-(--shell-content)">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--shell-accent)/12 text-(--shell-accent)">
          <Folder className="h-7 w-7" />
        </span>
        <div className="text-[15px] font-semibold text-foreground">
          {t("drive")}
        </div>
        <div className="max-w-[320px] text-[13px] text-muted-foreground">
          {t("comingHint")}
        </div>
      </div>
    </div>
  );
}
