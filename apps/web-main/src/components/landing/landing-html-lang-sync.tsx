"use client";

import { useEffect } from "react";

/**
 * 挂载后把 `<html lang>` 纠正为落地页实际内容语言。
 *
 * 背景：根 layout（`apps/web-main/src/app/layout.tsx`）服务全站，`<html
 * lang="zh-CN">` 是硬编码——为落地页双语上线重构它风险过大（会牵动应用内
 * 全部路由），故不改。`/` 恰好与硬编码值一致，天然满足 WCAG 3.1.1；`/en`
 * 用这个组件在客户端挂载时把 `lang` 改成 `en`，卸载时还原。
 *
 * 局限：首屏服务端 HTML 的 `lang` 仍是 `zh-CN`，要等这段脚本执行（hydration
 * 后）才纠正为 `en`。不执行 JS 的抓取器/读屏器在这之前读到的语言标注不准，
 * 是本方案已知的权衡——详见 task 9 报告；换取的是 `/en` 仍保持 `○ Static`
 * 静态预渲染（root layout 若为此读 `headers()`/`cookies()` 会让全站退化为
 * 动态渲染）。
 */
export function LandingHtmlLangSync({ lang }: { lang: string }) {
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.lang;
    html.lang = lang;
    return () => {
      html.lang = prev;
    };
  }, [lang]);

  return null;
}
