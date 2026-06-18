"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function AreaPlaceholder({
  titleKey,
  bodyKey,
}: {
  titleKey: string;
  bodyKey: string;
}) {
  const router = useRouter();
  const t = useTranslations("appShell");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-semibold text-foreground">{t(titleKey)}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{t(bodyKey)}</p>
      <button
        type="button"
        onClick={() => router.push("/assistant")}
        className="mt-2 rounded-(--shell-radius) bg-(--shell-accent) px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-(--shell-accent-hover)"
      >
        {t("placeholder.goAssistant")}
      </button>
    </div>
  );
}
