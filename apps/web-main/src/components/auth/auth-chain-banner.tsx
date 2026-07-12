"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

/** 从 ?next= 判断当前登录/注册处于设备授权链中；返回 next 原串与 requestId。 */
export function useAuthChainNext(): {
  next: string | null;
  requestId: string | null;
} {
  const searchParams = useSearchParams();
  const next = searchParams.get("next");
  if (!next?.startsWith("/authorize")) return { next, requestId: null };
  const requestId = new URLSearchParams(next.split("?")[1] ?? "").get(
    "request",
  );
  return { next, requestId };
}

/** 授权链提示条：告知用户完成当前步后将继续设备授权。 */
export function AuthChainBanner() {
  const t = useTranslations("wizard");
  const { requestId } = useAuthChainNext();
  if (!requestId) return null;
  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-(--shell-accent)/20 bg-(--shell-accent)/5 px-3 py-2 text-xs text-(--shell-accent)">
      ⚡ {t("chainBanner")}
    </div>
  );
}
