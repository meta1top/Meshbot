"use client";

import { Github } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { installSkill } from "@/rest/skills";

interface Props {
  onInstalled: () => void;
}

/**
 * GitHub 安装输入框：输入 owner/repo[@ref]，点「安装」后调 installSkill，
 * 成功后刷新已装列表 + 内联成功提示 + 清空输入框。
 */
export function InstallFromGithub({ onInstalled }: Props) {
  const t = useTranslations("skills");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleInstall() {
    const trimmed = ref.trim();
    if (!trimmed) return;
    setBusy(true);
    setSuccessMsg(null);
    setErrorMsg(null);
    try {
      await installSkill({ source: "github", ref: trimmed });
      setSuccessMsg(t("installSuccess", { name: trimmed }));
      setRef("");
      onInstalled();
    } catch {
      setErrorMsg(t("installFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 标题 */}
      <div className="flex items-center gap-2">
        <Github className="h-5 w-5 text-foreground/70" />
        <h2 className="text-base font-medium">{t("githubTitle")}</h2>
      </div>

      {/* 说明文案 */}
      <p className="text-sm text-muted-foreground">{t("githubDesc")}</p>
      <div className="rounded-md bg-muted/50 px-3 py-2 text-[12px] text-foreground/60">
        <p className="font-medium">{t("githubFormatLabel")}</p>
        <ul className="mt-1 list-disc pl-4">
          <li>owner/repo</li>
          <li>owner/repo@branch</li>
          <li>owner/repo@v1.2.3</li>
        </ul>
      </div>

      {/* 输入 + 安装按钮 */}
      <div className="flex gap-2">
        <input
          type="text"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleInstall();
          }}
          placeholder={t("githubPlaceholder")}
          disabled={busy}
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void handleInstall()}
          disabled={busy || !ref.trim()}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? t("installing") : t("install")}
        </button>
      </div>

      {/* 反馈 */}
      {successMsg && (
        <p className="text-sm text-green-600 dark:text-green-400">
          {successMsg}
        </p>
      )}
      {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}
    </div>
  );
}
