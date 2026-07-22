"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  detectPlatform,
  type Platform,
  RELEASES_LATEST_URL,
} from "@/lib/download-platform";

/**
 * 落地页下载 CTA：按访问者 UA 推断桌面平台，副文案只提示当前平台，
 * 链接恒为 GitHub Releases 最新版页面（不做重定向，用户在该页自行
 * 挑选安装包）。`detectPlatform` 只在挂载后的 `useEffect` 里调用
 * （依赖 `navigator`，SSR 阶段不可用），首次渲染与服务端一致输出
 * "unknown" 分支，避免 hydration mismatch。
 *
 * iPad 运行时兜底（不要改 `detectPlatform` 本身）：iPadOS 13+ 的
 * Safari 发送桌面伪装 UA（形如
 * `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) ...`），不含任何
 * `iPad`/`iPhone` token，在 UA 字符串层面与真实 macOS 完全无法区分——
 * `detectPlatform` 是已有单测锁定行为的纯函数，对此确实无解。这里用
 * `navigator.maxTouchPoints > 1` 做运行时兜底：触屏设备即使 UA 判成
 * mac，也回退到 unknown，展示全平台列表，而不是把 macOS 安装包
 * 误导性地推荐给平板用户。
 */
export function LandingDownloadButton() {
  const t = useTranslations("landing.hero");
  const [platform, setPlatform] = useState<Platform>("unknown");

  useEffect(() => {
    const detected = detectPlatform(navigator.userAgent);
    const isTouchDevice = navigator.maxTouchPoints > 1;
    setPlatform(detected === "mac" && isTouchDevice ? "unknown" : detected);
  }, []);

  const note =
    platform === "mac"
      ? t("platformMac")
      : platform === "win"
        ? t("platformWin")
        : platform === "linux"
          ? t("platformLinux")
          : t("platforms");

  return (
    <>
      <a className="lp-btn lp-btn-g" href={RELEASES_LATEST_URL}>
        {t("download")}
      </a>
      <span className="lp-cta-note">{note}</span>
    </>
  );
}
